# 005 New versions and carry-over

Status: Draft (inferred from the schema; confirm open questions before building)
Depends on: 002, 003, 004

## Goal

Uploading a new PDF for an existing document creates the next version, supersedes the old one, links each new value to the same field in the prior version, and carries reviews forward where the value did not change.

## Requirements

1. `POST /documents/:id/versions` with a raw PDF, same validation and the same upload order as 002: put the object, then one transaction, then enqueue.
2. In the transaction: `version_no = max(version_no) + 1` for the document; mark the previous current version `superseded`; set `documents.current_version_id` to the new version.
   - Two concurrent uploads race on the unique `(document_id, version_no)`; the loser retries the transaction.
3. A version that is `extracting` when superseded finishes its run as `superseded` and writes no values (003 requirement 8).
4. When the new version is extracted, each value's `previous_value_id` points at the value with the same `field_key` in the prior extracted version.
5. **Carry-over.** If a new value equals the prior version's effective value and that prior value had a review, copy the latest review onto the new value with `carried_from_review_id` set, and set the new value's `review_status` to `carried_over`. Otherwise it stays `pending`.
6. Carry-over happens in the same transaction that writes the new values.

## Design notes

- "Prior version" means the most recent earlier version that reached `extracted`, not simply `version_no - 1`, since a version can be superseded before extraction.
- The equality rule for carry-over is the riskiest decision here; keep it in one function with focused tests.

## Out of scope

- Diff UI between versions.

## Acceptance criteria

- [ ] Unit: version numbering and superseding, including the concurrent-upload race.
- [ ] Unit: `previous_value_id` links skip versions that never extracted.
- [ ] Unit: unchanged approved value carries over; changed value stays pending; a corrected prior value carries over only when the new model output equals the corrected value.
- [ ] E2E in docker: upload v1, extract, approve a field, upload v2 with the same field value, the field arrives `carried_over` with a copied review.

## Open questions

1. Equality for carry-over: exact string match, or normalised (whitespace, case, number and date formats)?
2. Should a corrected review carry over when the new model output still equals the old wrong value (the human already fixed it once)?
3. Should uploading identical bytes (same sha256 as the current version) create a new version at all?
