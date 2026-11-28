# 005 New versions and carry-over

Status: Done (revision 2, from the user's requirements on 2026-11-27; in review on branch `new-versions`)
Depends on: 002, 003, 004, 007

## Goal

Uploading a new PDF for an existing document creates its next version.
When that version is extracted, each value links to the same field in the latest earlier extracted version, and the review carries forward where the field did not change.

## Requirements

1. `POST /documents/:id/versions` takes a multipart `file`; the type comes from the existing document.
   Same validation as `POST /documents` (002): `415` for a body that is not multipart, `400` for a missing, oversized or non-PDF file.
2. It reuses `createVersion`: put the object, then one transaction, then enqueue.
   Inside the transaction:
   1. `SELECT ... FROM documents WHERE id = $1 FOR UPDATE`, the same lock reviews (004) and the worker's commit take.
   2. `404 { error: "document not found" }` if the document does not exist.
   3. `409 { error: "identical_to_current" }` if the file's sha256 equals the current version's sha256.
   4. Insert the version with `version_no = max(version_no) + 1` and status `queued`, and set `documents.current_version_id` to it.
   5. The previous version's status is not touched: one still being extracted supersedes itself at commit (003), and an extracted one stays `extracted`.
3. It responds `202 { id, versionId, versionNo, status }`.
   `POST /documents` shares the response code and now returns `versionNo` too.
4. **Base version**: the latest version of the document with status `extracted` and a lower `version_no`.
   Superseded and failed versions are skipped.
   With no base version, every value is `pending` with no previous value.
5. **Carry-over** is a pure function, `carryOver` in `packages/core/src/carryOver.ts`.
   - Input: the base version's values, each with its latest review or null; the new version's validated values; the new version's `parsed_text`.
   - Output, for each new value in order: `{ reviewStatus, previousValueId, carriedReview | null }`.
   - Values match by `field_key`.
     `norm()` collapses whitespace and trims, as evidence validation does.
   - `unchanged(p, n)` is `norm(p.value) == norm(n.value)` (both null counts as equal) and one of:
     `norm(p.evidence) == norm(n.evidence)`;
     `p.evidence` is not null and `norm(nextText)` contains `norm(p.evidence)`;
     both evidence are null (a gap that is still a gap).
   - Unchanged, and `p` has a review: `carried_over`, and the review is copied into a new `reviews` row with the same `action`, `correctedValue` and `note`, and `carried_from_review_id` set to the original.
   - Unchanged, and `p` has no review: `pending`, with nothing to carry.
   - Changed: `pending`, so the UI shows the old value and its review beside the new one.
   - A field the base version does not have: `pending`, with no previous value.
   - `previous_value_id` is set whenever the base version has a value for that key.
6. **The worker's commit** (the hook in step 6 of `apps/worker/src/extract.ts`): inside the commit transaction, after the currency check and with the document lock held, it loads the base version's values and their latest reviews, runs `carryOver`, inserts the values with the resulting `review_status` and `previous_value_id`, then inserts the copied reviews.
   Every review of the base version committed up to that moment is included, because of the lock.

## Design notes

- Carry-over compares the model's own value, not the effective value.
  A corrected review carries over when the model reads the same value from the same passage again, so the effective value keeps the correction.
- Evidence counts as unchanged when the old quote is still in the new text, so a model quoting a different span of an unchanged passage, or text that moved or re-wrapped, does not reset a review.
- Two attempts of one version can both reach the commit (an expired lease reclaimed, 007).
  Values insert with `ON CONFLICT DO NOTHING`, and reviews are copied only for the values that attempt inserted, so the second commit copies none.
- Concurrent uploads of one document queue on the document lock, so `max(version_no) + 1` cannot collide; the race the Draft planned to retry no longer exists.
- A `queued` version that is no longer current is claimed, parsed and then superseded by the worker's currency check, without a model call.
- The object is put before the transaction, so a refused version can leave an object behind.
  For `409` it is the content-addressed object already stored; for `404` it is an orphan, like one left by a failed transaction.
- The integration test needs both the API and the worker, so `@lomi/worker` exports `./extract` and is a dev dependency of `@lomi/api`.

## Out of scope

- A diff UI between versions.
- Normalising case, number or date formats before comparing values.

## Acceptance criteria

- [x] Unit (`packages/core/tests/carryOver.test.ts`, table-driven): same value and evidence, reviewed, carries over; a different span with the old evidence still in the new text carries over; old evidence gone from the new text is `pending` with a previous value; a changed value is `pending`; the same evidence with a different value is `pending`; a reviewed gap that stays a gap carries over; value to gap and gap to value are `pending`; unchanged but never reviewed is `pending` with `previousValueId` set; a correction carries over with its `correctedValue`; text shifted by lines added above and re-wrapped, values unchanged, carries over; a new field and a missing base version are `pending` with no previous value.
- [x] Unit (`apps/api/tests/create-version.test.ts`): a new version takes the document lock, gets `max + 1`, and leaves the previous version alone; an unknown document and the current version's bytes are refused without a write or an enqueue.
- [x] Route (`apps/api/tests/app.test.ts`): `202` with `versionNo` and the document id passed through; `400` for a missing, non-PDF or oversized file; `415`; `404`; `409 identical_to_current`; `503`.
- [x] Integration against Postgres (`apps/api/tests/carry-over.test.ts`, the API over HTTP and the worker's `processVersion` with a fake model that answers from the PDF it is shown): version 1 of the invoice is uploaded, extracted and every value reviewed (3 approves, 2 corrections); the fixture version 2 is uploaded and extracted; exactly `due_date` and `total_amount` are `pending`, each with the previous value and its review; the other 3 are `carried_over`, each with a new review row pointing at the original, a correction keeping its effective value; version 1's values and reviews are unchanged in the database and returned by `GET /documents/:id/versions/1`; the same bytes again are `409` and an unknown document `404`.
- [x] Integration: version 2 uploaded while version 1 is extracting supersedes version 1, and version 2 has no base, so all its values are `pending` with no previous value.
- [x] Integration: version 3 uploaded while version 2 is extracting supersedes version 2, and version 3 carries over from version 1, the latest extracted version.
- [x] Integration (`apps/worker/tests/extract.test.ts`): when a reclaimed attempt commits a new version first, each carried review exists once.
- [x] E2E in docker with the real model and the api and worker images rebuilt from this branch: on the seeded `doc-invoice-001`, 3 approves and 2 corrections on version 1, then `invoice-001.v2.pdf` through `POST /documents/doc-invoice-001/versions` returned `202` with `versionNo` 2.
  The worker extracted it; exactly `due_date` and `total_amount` came back `pending` with version 1's value and review as `previous`, and the other 3 `carried_over` with review rows pointing at version 1's reviews, `vendor_name` keeping its corrected effective value.
  Progress read 2 pending and 3 carried over; `GET /documents/doc-invoice-001/versions/1` and version 1's review rows were identical before and after, and version 1 stayed `extracted`.
  The same bytes again returned `409 identical_to_current`, an unknown document `404`, and a non-PDF `400`.

## Open questions

None.
Answered 2026-11-27: equality is whitespace-normalised only, with evidence as above; a corrected review carries over when the model's value and evidence are unchanged; uploading the current version's bytes is refused with `409`.
