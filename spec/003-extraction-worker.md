# 003 Extraction worker (happy path)

Status: Done (verified 2026-11-27, merged in PR #2; design given by the user)
Depends on: 001, 002

## Goal

The worker turns a `queued` document version into extracted field values, each with verified evidence or a gap reason, records every attempt with its prompt and raw model response, and never writes values for a version that was superseded.
Pure logic lives in `packages/core` so it is unit-tested without Postgres, Redis or an LLM.

## Requirements

1. **Job.** The worker consumes `extract` jobs `{versionId}` from BullMQ queue `extraction`, with concurrency `WORKER_CONCURRENCY` (default 2).
2. **Claim.** One statement:
   `UPDATE document_versions SET status='extracting', lease_until = now() + interval '5 minutes', attempts = attempts + 1, error = null, updated_at = now() WHERE id = $1 AND (status = 'queued' OR (status = 'extracting' AND lease_until < now())) RETURNING *`.
   No row: log "not claimable" and return; that is not an error.
   Then insert an `extraction_runs` row (`attempt`, `model`, `started_at`) and keep its id.
3. **Parse.** Download the PDF from MinIO by `storage_key` and extract its text with unpdf (Mozilla pdf.js), keeping the parser's reading order and output unchanged.
   Save `parsed_text` on the version in its own small update, outside the final transaction.
   Empty text throws `no_text_layer`.
4. **Currency check before the LLM.** If `documents.current_version_id` is not this version, mark it superseded (requirement 7) and return without calling the model.
5. **LLM call** (`packages/core`: `buildPrompt`, `callLlm`).
   - Fields come from `fixtures/expected-fields.json` for the document's type.
   - Anthropic SDK with structured output (a zod schema); the model comes from `LLM_MODEL`.
   - Output per field: `{key, value: string | null, evidence: string | null, reason: string | null}`.
   - Prompt rules: evidence is an exact quote copied from the text; a field that is not present gets `value: null` and a reason; never infer or compute values.
   - Save `prompt` on the run before the call and `raw_response` right after it, so both survive any later failure.
   - Validate the response with zod; a failure throws `llm_invalid_output`.
6. **Evidence validation** (`packages/core`: `validateEvidence`, pure).
   - Normalize only whitespace (collapse runs to one space, trim) on both the evidence and the text, keeping a map back to the original offsets.
   - Evidence found: keep the value; store the matching slice of the original `parsed_text` as `evidence`, with `evidence_start` / `evidence_end` in the original text, so `parsed_text.slice(start, end) === evidence` always holds.
   - Evidence missing or not found: `value` null, `gap_reason` `evidence_not_found`.
   - LLM returned null: `value` null, `gap_reason` = the LLM's reason, or `not_found`.
   - Every expected field yields exactly one row, even if the LLM omitted it (`missing_from_llm_output`).
   - Fields the LLM returned that are not expected are dropped and logged.
7. **Commit, one transaction.**
   - `SELECT current_version_id FROM documents WHERE id = $doc FOR UPDATE`.
   - Not this version: status `superseded`, run outcome `superseded`, no values, commit, return.
   - Otherwise insert all values with `review_status = 'pending'` and `ON CONFLICT (version_id, field_key) DO NOTHING`, then the marked hook for carry-over (spec 005), then status `extracted`, `lease_until` null, run outcome `succeeded` with `finished_at` and tokens.
8. **Failure.** Steps 3 to 7 are wrapped. On any error:
   - the version becomes `failed` with `error` = short code + message and `lease_until` null, but only while it is still `extracting` (a superseded version stays superseded);
   - the run gets outcome `failed`, `error` and `finished_at`;
   - the error is not rethrown, so BullMQ does not retry. Retry is an explicit user action (a later spec). The stack is logged.
9. **Config.** `ANTHROPIC_API_KEY`, `LLM_MODEL` (compose default `claude-opus-5-5`), `WORKER_CONCURRENCY`, the `S3_*` variables, and `EXPECTED_FIELDS_PATH`.
10. Remove the legacy in-memory `JobStore`, `enqueue` (api `index.ts`), `processNext` (worker `index.ts`), `createJob` (core) and their tests, and `packages/shared`, which only that scaffolding used.

## Design notes

- **Superseding in flight (v2 uploaded while v1 is being extracted).** The upload transaction (`createVersion`, spec 002) marks v1 `superseded` and moves `documents.current_version_id` to v2 together.
  The commit locks the documents row with `FOR UPDATE`, and the upload also updates that row, so Postgres orders them:
  - v1 still `queued`: the claim never matches a `superseded` row, so the job is dropped.
  - v1 before its model call: requirement 4 stops it without calling the model.
  - v1 after its model call, before commit: requirement 7 sees v2 is current and writes nothing; v2's run provides the values.
  - v1 committed just before v2's upload: v1 keeps its values and is then marked `superseded`. That is correct, and spec 005 uses those values as v2's prior version.
  - Spec 005 changed the upload: it no longer marks v1 `superseded`, and it takes the document lock itself.
    A `queued` v1 is claimed, parsed and superseded by requirement 4 without a model call; an extracted v1 stays `extracted` and is the base for carry-over.
- `extraction_runs.prompt` becomes nullable (new migration): the run row exists before the prompt can be built, so parse failures are recorded on it.
- The document type `report` is renamed to `market_report` (new migration) to match `fixtures/expected-fields.json` and `fixtures/documents.json` from the assignment.
- **No `temperature: 0`.** The default model (`claude-opus-5-5`) rejects sampling parameters with a 400, and so does API version `2026-10-21` on every model. Determinism comes from structured output plus evidence validation; `effort` is set explicitly to `medium`.
- **No forced tool use.** `claude-opus-5-5` rejects forced `tool_choice`; structured output (`output_config.format` from the SDK's zod helper) is the replacement.
- Server-side refusal fallbacks are on (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`), as recommended for this model.
- `raw_response` stores the whole API response as JSON (content, stop reason, usage), not only the text.
- Error codes: `no_text_layer`, `llm_request_failed` (the API call failed), `llm_invalid_output` (refusal, truncation, invalid JSON or schema mismatch), `unknown_document_type`, `unexpected_error`.
- The model call is behind an interface so worker tests use a fake.
- The lease is not re-checked at commit: `ON CONFLICT DO NOTHING` keeps a second attempt that reclaimed an expired lease from duplicating values.
- BullMQ keeps completed jobs, so re-enqueueing the same `jobId = versionId` is a no-op. The retry action and the sweeper (later specs) must remove the old job or use a new id.
- Spec 007 replaced the 5-minute lease with `LEASE_SECONDS` and a heartbeat, removes finished jobs from Redis, caps attempts at 3, and adds the reconciler and the retry endpoint.

## Out of scope (later specs)

- Carry-over (spec 005; a marked hook sits in the commit).
- Sweeper / reconciler for stuck `queued` and expired `extracting` versions, and Redis flush recovery.
- Retry endpoint.
- OCR for scanned PDFs.

## Acceptance criteria

- [x] Unit (core): `validateEvidence` exact match; whitespace and newline differences still match with correct original offsets; hallucinated quote becomes a gap; LLM null becomes a gap with its reason; omitted field becomes a gap; extra field is dropped.
- [x] Unit (core): LLM output that is not valid JSON, does not match the schema, or stopped on refusal or `max_tokens` throws `llm_invalid_output`; text extraction of a PDF with no text throws `no_text_layer`; parsing does not detach the caller's buffer.
- [x] Worker against real Postgres (mocked LLM and storage): happy path ends `extracted` with one value per expected field.
- [x] Worker: running the same job twice, and a second attempt that reclaims an expired lease and commits first, never duplicate values.
- [x] Worker: an LLM error ends `failed` with the error, and the run is recorded with outcome `failed`.
- [x] Worker: superseded before commit writes no values and the run ends `superseded`; superseded before the LLM call never calls the model.
- [x] E2E in docker with the real model (`claude-opus-5-5`): uploading `fixtures/documents/invoice-001.pdf` returned `202` in 0.16 s and ended `extracted` about 6 s later with 5 pending values; all 5 quotes are at their offsets in `parsed_text`; the run has outcome `succeeded`, the prompt, the raw response (`stop_reason` `end_turn`) and tokens (1061 in, 257 out).
- [x] E2E: the lease and the market report also ended `extracted`; the lease's line-spanning term quote matched; the report's missing `median_household_income` is a gap with the model's reason.
- [x] E2E: a PDF without text ended `failed` with `no_text_layer` on the version and the run, and no model call.

Worker tests run with `TEST_DATABASE_URL=postgres://lomi:lomi@127.0.0.1:5433/lomi pnpm turbo run test`; without it they show as skipped.

## Open questions

- Documents longer than the context window: not an issue for one-page fixtures; the whole `parsed_text` is sent.
