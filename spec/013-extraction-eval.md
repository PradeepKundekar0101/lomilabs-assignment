# 013 Extraction eval

Status: Done (verified 2026-11-28; not committed yet)
Depends on: 003, 005

## Goal

A small, repeatable measure of extraction quality: run the real pipeline functions against hand-confirmed labels for the fixture PDFs, with the real model, and report accuracy, evidence, run-to-run agreement, tokens, cost and latency.
It runs on demand with `pnpm eval`, never in tests or CI.

## Requirements

1. Labels live in `packages/evals/labels/<doc-id>-v<n>.json`, one per fixture PDF: `doc-invoice-001-v1`, `doc-invoice-001-v2`, `doc-lease-001-v1`, `doc-report-001-v1`.
   The upstream assignment has exactly these four PDFs; invoice v2 is one of them.
2. A label file is `{ "confirmed": boolean, "fields": { "<field>": { "expected": string | null } } }`, with one entry per field of the document's type in `fixtures/expected-fields.json`.
   `expected: null` means the field must come back as a gap.
   The document's type and PDF path come from `fixtures/documents.json`, not from the label.
3. Labels are drafted by Claude and set `confirmed: true` only by the user, by hand.
   `pnpm eval` refuses to run while any label is unconfirmed, or has fields missing or extra against `expected-fields.json`.
4. `pnpm eval` builds `@lomi/core` and runs `packages/evals/src/run.ts`, which for each labelled PDF runs, 3 times, the worker's pipeline functions: `extractPdfText`, `buildPrompt`, `createLlm(LLM_MODEL)`, `parseLlmOutput`, `validateEvidence`.
   No database, no queue, no object storage.
   `ANTHROPIC_API_KEY` and `LLM_MODEL` come from the root `.env`, parsed with zod like every other entry point; `LLM_MODEL` falls back to `claude-opus-5-5`, as in `docker-compose.yml`.
5. Each validated value is compared with its label by `sameValue(type, expected, got)`, which is option B below:
   - both `null` are equal; `null` and a value are not;
   - `string` (and any other type): whitespace collapsed with core's `norm()`, then case-insensitive;
   - `money`, `number`, `percent`: the first number in each, commas removed (`$5,230.29` and `5230.29` are equal);
   - `date`: both as ISO `YYYY-MM-DD` (`March 1, 2025` and `2025-03-01` are equal);
   - a side that does not parse as its type falls back to the string comparison.
6. It runs `carryOver` from each labelled version to the next labelled version of the same document (today only invoice v1 to v2), for each of the 3 run pairs (v1 run i with v2 run i), with a synthetic `approve` review on every v1 value.
   The pair passes when the fields that come back `pending` are exactly the fields whose two labels differ under `sameValue`.
7. It prints a table per document and an overall row with:
   field accuracy, gap accuracy, evidence pass rate, evidence rejections, agreement across the 3 runs, tokens in and out, a cost estimate, and p50 latency.
   Then the carry-over result per pair, then every mismatch with document, run, field, expected and got.
8. It writes everything it printed, plus each run's model output and validated values, to `packages/evals/results/<timestamp>.json`.

## Metric definitions

- **Field accuracy:** of the (field, run) pairs whose label is a value, the share whose validated value matches it.
- **Gap accuracy:** of the (field, run) pairs whose label is `null`, the share that came back as a gap.
- **Evidence pass rate:** of the expected fields the model returned a value for, the share whose evidence `validateEvidence` found in the text.
- **Evidence rejections:** the count of those values that `validateEvidence` turned into gaps.
- **Agreement:** the share of fields whose 3 validated results are equal to each other under `sameValue` (all gaps counts as equal).
- **Tokens in/out:** summed from each call's usage.
- **Cost estimate:** tokens times the model's list price per million tokens, from a price table in `score.ts` (`claude-opus-5-5`: $4 in, $20 out); a model missing from the table shows `n/a`.
- **p50 latency:** the median wall time of the model calls that returned.

A run whose call or parse throws (`llm_request_failed`, `llm_invalid_output`) counts every field as wrong and never agreeing, and its error is listed with the mismatches.

## Out of scope

- Running in CI or in `pnpm test`.
- A database, queue, storage, or the worker process itself.
- Prompt or model changes; this spec only measures.
- Changing carry-over's comparison (option A); see open question 1.
- Labels for documents beyond the four fixture PDFs.

## Design notes

- The eval is its own workspace package, `packages/evals`, depending on `@lomi/core`.
  It was going to live in `packages/core/evals`, but the runner runs on Node's type stripping and so must import core's built `dist`, and turbo only builds a package's dependencies before its typecheck, not the package itself.
- `packages/evals` has no build: `tsconfig.json` sets `noEmit` and `allowImportingTsExtensions`, so `src/run.ts` runs directly with `node`.
- `src/score.ts` holds the pure comparison, label check and metric code, unit tested in `tests/score.test.ts`; `src/run.ts` does the file reading, model calls, printing and writing, and is checked by running it.
- Runs go one after another, so latency is not inflated by concurrent calls.
- `packages/evals/results/` is gitignored; a result worth keeping can be committed on purpose.

## Acceptance criteria

- [x] All four labels exist and the user has confirmed each one (`confirmed: true` set by the user, 2026-11-28).
- [x] `pnpm eval` with an unconfirmed label exits non-zero and names the label, before any model call. Verified 2026-11-28 with all four labels unconfirmed: exit 1, each label named, no results file written.
- [x] `pnpm eval` prints the per-document and overall tables, the carry-over check and the mismatch list, and writes the results file. Verified by running it with the real model (see Verification).
- [x] `sameValue`, the label check and the metrics have a unit test (`packages/evals/tests/score.test.ts`, 18 tests).
- [x] `pnpm turbo run build typecheck lint test` passes and does not run the eval. Verified 2026-11-28 with the test database and Redis: 27 tasks, 148 tests, none skipped.

## Verification

First real-model run, 2026-11-28 14:28 UTC, `claude-opus-5-5`, 4 documents x 3 runs:

| Document | Field acc | Gap acc | Evidence pass | Rejected | Agreement | Tokens in | Tokens out | Cost | p50 |
|---|---|---|---|---|---|---|---|---|---|
| doc-invoice-001-v1 | 100% (15/15) | - | 100% (15/15) | 0 | 100% (5/5) | 3183 | 771 | $0.0282 | 2.6s |
| doc-invoice-001-v2 | 100% (15/15) | - | 100% (15/15) | 0 | 100% (5/5) | 3345 | 771 | $0.0288 | 2.9s |
| doc-lease-001-v1 | 100% (15/15) | - | 100% (15/15) | 0 | 100% (5/5) | 3363 | 687 | $0.0272 | 2.5s |
| doc-report-001-v1 | 100% (15/15) | 100% (3/3) | 100% (15/15) | 0 | 100% (6/6) | 3384 | 924 | $0.0320 | 3.1s |
| Overall | 100% (60/60) | 100% (3/3) | 100% (60/60) | 0 | 100% (21/21) | 13275 | 3153 | $0.1162 | 2.8s |

- Carry-over from invoice v1 to v2 passed in all 3 run pairs: exactly `due_date` and `total_amount` lost their review.
- No mismatches and no failed runs.
- 20 of the 21 fields came back character for character as labelled.
  `average_rent_1br` came back as `$1,985 per month` in all 3 runs and matches only under `sameValue`'s number parsing.
- No field's formatting differed between runs, so this run gives no evidence for option A.
- The fixtures are four short, clean PDFs, so a perfect score says the pipeline handles them, not that it generalizes.

## Open questions (answered 2026-11-28)

1. **`norm()` does less than the request assumed.**
   The `norm()` carry-over uses (`packages/core/src/evidence.ts`) only collapses whitespace and trims; it does not fold case, parse amounts as numbers or parse dates as ISO.
   The options were: A, one type-aware comparison used by both carry-over and the eval (a product change to spec 005); B, that comparison for the eval only, built on `norm()`; C, `norm()` exactly as it is.
   **Answer: B.** If the agreement metric shows the model's formatting drifting between runs, that is the evidence for A as its own change.
2. **The drafted labels.**
   **Answer:** the user confirmed all four as drafted (vendor name with "LLC", market area with "Submarket", lease start as written, term months `24`); the `confirmed` flags are theirs to set.
