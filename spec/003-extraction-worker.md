# 003 Extraction worker

Status: Draft (inferred from the schema; confirm open questions before building)
Depends on: 001, 002

## Goal

The worker turns a `queued` document version into extracted field values with evidence, safely under retries, crashes and concurrent workers, and records every attempt.

## Requirements

1. The worker consumes `extract` jobs `{versionId}` from BullMQ queue `extraction`.
2. **Claim with a lease.** In one atomic `UPDATE ... RETURNING`, move the version to `extracting`, increment `attempts`, and set `lease_until = now() + lease`, only if it is `queued`, or `extracting` with an expired lease. If no row is returned, drop the job (someone else owns it, or it is done or superseded).
3. Read the PDF from object storage by `storage_key`. The worker needs the same `S3_*` env vars as the api (not yet set on the worker in compose).
4. Parse the PDF to text and store it in `parsed_text` (once per version; reuse on retries).
5. Insert an `extraction_runs` row per attempt with `attempt`, `model`, `prompt`, `started_at` before calling the model, and record `raw_response`, `outcome`, `error`, `tokens_in`, `tokens_out`, `finished_at` when it ends.
6. Call the LLM with the field list for the document type and parse a structured response: per field, `value` or a `gap_reason`, plus `evidence` text.
7. **Verify evidence.** `evidence_start` / `evidence_end` must be offsets into `parsed_text` and `parsed_text.slice(start, end)` must equal `evidence`. Compute the offsets in code by searching `parsed_text`; never trust offsets from the model. If the evidence cannot be found, treat that field as a gap with a reason.
8. **Commit atomically.** In one transaction: insert all `extracted_values` (`review_status = pending`), set the version to `extracted`, clear `lease_until`, and finish the run as `succeeded`. Do this only if the lease is still ours and the version is not `superseded`; otherwise finish the run as `superseded` and write no values.
9. **Failure.** Finish the run as `failed` with `error`. If `attempts` is below the max, set the version back to `queued` and retry with backoff; otherwise set it to `failed` with `error`.
10. **Sweeper.** Periodically re-enqueue versions that are `queued` with no live job (for example after the api's enqueue failed) and `extracting` versions whose lease expired. The `document_versions(status, lease_until)` index exists for this query.
11. Remove the legacy in-memory `JobStore`, `enqueue` (api `index.ts`) and `processNext` (worker `index.ts`) and their tests.

## Design notes

- BullMQ will not add a job whose `jobId` matches one it still keeps (completed or failed). The api uses `jobId = versionId`, so a re-enqueue from the sweeper silently does nothing unless jobs are removed on completion or failure, or the sweeper uses a different id (for example `versionId:attempt`). Decide this explicitly and test it.
- The unique `(version_id, field_key)` constraint is the last line of defence against double extraction; a unique violation in step 8 means another attempt already committed, so finish as `superseded`.
- Default model: the latest Claude model available, configured with an env var (for example `EXTRACTION_MODEL`). Load the `claude-api` skill before writing the client code.
- Keep the model call behind an interface so tests use a fake; one end-to-end check can hit the real API.

## Out of scope

- OCR for scanned PDFs (unless the user says otherwise).
- UI for runs.

## Acceptance criteria

- [ ] Unit: two concurrent claims on one version, exactly one succeeds.
- [ ] Unit: an expired lease can be reclaimed; a live one cannot.
- [ ] Unit: evidence offsets always satisfy `parsed_text.slice(start, end) === evidence`; missing evidence becomes a gap.
- [ ] Unit: a version superseded mid-run writes no values and the run ends `superseded`.
- [ ] Unit: failure below max attempts re-queues; at max it ends `failed`.
- [ ] E2E in docker: upload a real PDF, the version reaches `extracted`, values and one `succeeded` run exist.
- [ ] E2E: kill the worker mid-extraction, restart, the sweeper recovers the version.

## Open questions

1. Which fields does each document type have (`invoice`, `lease`, `report`)? Static list in code, or a table?
2. Which PDF text extraction library? (Must give stable text so offsets stay meaningful.)
3. Lease length, max attempts, backoff schedule?
4. "Append-only" for `extraction_runs`: is filling in the finish fields on the same row acceptable, or must the finish be a separate row?
5. Should the model receive the whole `parsed_text`, and what happens with documents longer than the context window?
