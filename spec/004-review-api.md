# 004 Review API

Status: Done (revision 2, from the user's requirements on 2026-11-27; merged in PR #5)
Depends on: 001, 003, 007

## Goal

Humans can see a document's extracted values with their evidence, and approve or correct each one, with a full, never-rewritten review history.
Corrections live beside the extracted value: `extracted_values.value` is never changed, the correction is stored in `reviews`.

## Requirements

1. `POST /values/:id/review` with a JSON body, validated with zod and discriminated on `action`:
   - `{ action: "approve", note?: string }`
   - `{ action: "correct", correctedValue: string, note?: string }`, where `correctedValue` is trimmed and must be non-empty.
   - `note` is at most 1000 characters.
   - Unknown keys are rejected, so an approve that carries `correctedValue` is invalid.
   - An invalid body is `400`. An unknown or malformed value id is `404`.
2. The review runs in one transaction:
   1. Load the value with its version and document. Missing is `404`.
   2. `SELECT ... FROM documents WHERE id = $doc FOR UPDATE`, the same lock the worker's commit takes, so a review never interleaves with a new version's commit and carry-over.
   3. If the value's version is not the document's current version, or its status is not `extracted`, respond `409 { error: "stale_version", currentVersionNo }`.
   4. Insert a `reviews` row. Reviews are append-only: no code path updates or deletes one.
   5. Set `extracted_values.review_status` to `approved` or `corrected`, also when it was `carried_over`: a new review overrides a carried one.
   6. Respond `200` with the updated value, in the same shape as `GET /documents/:id`.
3. A gap (`value` null) can be corrected (the reviewer supplies the missing value) or approved (the reviewer confirms it is genuinely absent).
4. Re-reviewing is allowed and the newest review wins; the history stays in `reviews`.
5. Double-click protection: if the value already has the status this review would set and its latest review has the same `action`, `correctedValue` and `note`, respond with the value without inserting another review.
6. `GET /documents/:id/progress` counts the current version's values: `{ versionNo, status, total, pending, approved, corrected, carriedOver, gaps }`.
   - `gaps` counts values with `value` null that are still `pending` (a subset of `pending`, shown separately).
   - One SQL query with `COUNT(*) FILTER (WHERE ...)`.
7. `GET /documents/:id` returns `values` for the current version, each:
   `{ id, fieldKey, value, evidence, evidenceStart, evidenceEnd, gapReason, reviewStatus, effectiveValue, latestReview, previous }`.
   - `effectiveValue` is the latest review's `correctedValue` when that review is a `correct`, else `value`.
   - `latestReview` is `{ action, correctedValue, note, createdAt }` or null.
   - `previous` is `{ versionNo, value, effectiveValue, latestReview }` of the value `previous_value_id` points at, or null.
   - Sort order: `pending` first (gaps last within `pending`), then `corrected`, `approved`, `carried_over`; within each group, the order of the document type's expected fields.
8. `GET /documents/:id/versions/:n` returns the same shape for version `n`, so old versions and their reviews stay queryable.
   Both document reads carry `currentVersion` (the document's current version) and `version` (the version `values` belong to).
   `404` for an unknown document or version number.

## Design notes

- `review_status` on `extracted_values` is a denormalised cache of the latest review; the review rows are the truth.
- The review reads the current version and the value's latest review only after taking the document lock, in new statements, so it sees what committed before it got the lock.
- A review's `created_at` is `clock_timestamp()` at insert, not `now()` (transaction start): the document lock orders reviews, and "latest review" must follow that order even when a later-started transaction got the lock first.
- Lock order is the same everywhere: the `documents` row first.
  An upload's insert into `document_versions` waits on the review's lock through the foreign key, so a review either commits before a new version exists (and the new version's carry-over sees it) or sees the new version and gets `409`.
- The API reads the expected fields from `EXPECTED_FIELDS_PATH`, like the worker, for the sort order.

## Out of scope

- Authentication and reviewer identity (there is no user table yet).
- A web UI for reviewing.
- An endpoint listing a value's full review history; the rows stay in `reviews`.
- A database trigger enforcing append-only `reviews`.
- Carry-over itself, which is spec 005; the worker's commit has a hook for it.

## Acceptance criteria

- [x] Route (`app.test.ts`): a correct without `correctedValue`, a blank `correctedValue`, an approve with `correctedValue`, a note over 1000 characters and a non-JSON body are `400`.
- [x] Integration against Postgres (`review.test.ts`): approve sets `approved` and writes 1 review row.
- [x] Integration: correct sets `corrected`, leaves `value` unchanged, and `effectiveValue` is the correction.
- [x] Integration: reviewing a value of a non-current version is `409 stale_version` with the current version number.
- [x] Integration: approve then correct leaves 2 review rows, and the correction wins.
- [x] Integration: the same approve twice leaves 1 review row.
- [x] Integration: a gap can be corrected and approved, and a `carried_over` value is overridden by a new review.
- [x] Integration: progress counts match the rows after a mix of reviews.
- [x] Integration: `GET /documents/:id` returns the value shape, `previous` and the sort order; `GET /documents/:id/versions/:n` returns an older version with its reviews.
- [x] Integration: a review racing a new version of the same document (upload, then a commit that takes the worker's lock) never deadlocks, and either commits before the new version (visible to its commit) or gets `409`.
- [x] E2E against the compose Postgres, Redis and MinIO, with the api run on the host (`node dist/main.js`, port 3001): on an invoice the real model extracted, an approve sent twice left 1 review row, a correction was trimmed and stored beside the unchanged value, the 400 and 404 cases held, and the order, progress and `versions/1` read back as expected.
- [x] E2E in docker with the rebuilt api image (`EXPECTED_FIELDS_PATH` from the Dockerfile): on a market report the real model extracted with one gap, the values came back in expected-field order with the gap last among the pending ones; approving the gap as absent, correcting `vacancy_rate` and two simultaneous approves of `market_area` left 3 review rows, and progress moved from 6 pending and 1 gap to 3 pending, 2 approved, 1 corrected and 0 gaps.

## Open questions

None.
Answered 2026-11-27: values of a non-current version get `409`; a gap can be corrected or approved; the web UI and reviewer identity are separate work.
