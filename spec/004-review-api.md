# 004 Review API

Status: Draft (inferred from the schema; confirm open questions before building)
Depends on: 001, 003

## Goal

Humans can see a document's extracted values with their evidence, and approve or correct each one, with a full, never-rewritten review history.

## Requirements

1. `GET /documents/:id` returns the document, its current version (status, attempts, error) and that version's values.
2. Each value includes `value`, `evidence`, offsets, `gap_reason`, `review_status`, and an **effective value**: the `corrected_value` of the latest `correct` review if there is one, else `value`.
3. `POST /values/:id/reviews` with `{action, correctedValue?, note?}`:
   - `approve` must not carry `correctedValue`.
   - `correct` must carry a non-empty `correctedValue`.
   - Inserts a `reviews` row and sets `extracted_values.review_status` to `approved` or `corrected` in one transaction.
4. `extracted_values.value` is never modified by a review.
5. `reviews` rows are never updated or deleted, by any code path.
6. `GET /values/:id/reviews` returns the history, oldest first.

## Design notes

- `review_status` on `extracted_values` is a denormalised cache of the latest review; the review rows are the truth.
- Consider enforcing append-only in Postgres (a trigger that raises on UPDATE/DELETE of `reviews`). See the open question in 001.

## Out of scope

- Authentication and reviewer identity (there is no user table yet).

## Acceptance criteria

- [ ] Unit: approve with a corrected value and correct without one are both rejected with 400.
- [ ] Unit: the effective value follows the latest review.
- [ ] Integration against Postgres: correcting twice leaves two review rows and the original `value` untouched.
- [ ] E2E in docker: upload, extract, correct a value through the API, read it back.

## Open questions

1. Can values of a non-current (superseded) version be reviewed?
2. Can a field that is a gap (`value` null) be "corrected" to supply a value?
3. Is a web UI for reviewing part of this spec, or a separate one? (`apps/web` currently only shows health.)
4. Does a reviewer identity need to be stored on `reviews`? That needs a schema change.
