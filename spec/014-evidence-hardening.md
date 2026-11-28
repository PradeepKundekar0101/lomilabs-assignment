# 014 Evidence hardening and CI

Status: Approved (requirements given by the user, 2026-11-28)
Depends on: 003, 005

## Goal

A kept value must be backed by its own quote, and the quote must be long enough to locate.
CI runs the full check on every push and pull request.

## Requirements

### 1. The value must appear inside its quote

1. After the quote is found in the parsed text, `validateEvidence` also requires `norm(value)` to be a substring of `norm(quote)`.
   Case-sensitive; whitespace collapsed with the existing `norm()`; no number or date parsing.
   The prompt already asks for the value "as the document states it", so a plain substring check is correct.
2. If it fails, the field is stored as a gap with reason `value_not_in_evidence`.
   The model's claimed value and quote stay in the run's `raw_response`, which the worker saves before validation (spec 003), so a reviewer can see what was rejected.

### 2. Reject quotes too short to locate

1. A quote shorter than 6 characters after `norm()` is a gap with reason `evidence_too_short`.
   A missing or empty quote stays `evidence_not_found`.
2. A quote that appears more than once in the text is accepted, and the first match is the one stored and highlighted.
3. Carry-over (spec 005) uses the "old evidence still appears in the new text" rule only when the old quote is at least 6 characters after `norm()`.
   Otherwise the field needs the same evidence to count as unchanged.

The checks run in this order: no quote (`evidence_not_found`), too short (`evidence_too_short`), not in the text (`evidence_not_found`), value not in the quote (`value_not_in_evidence`).

### 3. CI

1. `.github/workflows/ci.yml` runs on `push` and `pull_request`.
2. Node 26 (the version every Dockerfile builds with) and the pnpm version in `package.json` `packageManager`, with the pnpm store cached.
3. Postgres 18 and Redis as service containers, with `TEST_DATABASE_URL` and `TEST_REDIS_URL` set, so `migrate-test` and the integration tests run instead of skipping.
4. `pnpm install --frozen-lockfile`, then `pnpm turbo run lint typecheck build test`.
5. A second job runs `docker compose build`, so a broken Dockerfile fails CI.
6. No secrets: no test calls the real model.

## Out of scope

- Number, date or case-insensitive value matching (spec 013's option A).
- Showing the rejected value and quote in the review UI.
- Picking a better match than the first when a quote repeats.
- Re-validating values already stored.

## Design notes

- `MIN_QUOTE_LENGTH = 6` lives in `packages/core/src/evidence.ts` and carry-over imports it, so both rules use one number.
- The minimum is measured on the normalised quote, so `"$5  "` and `"$5"` are the same length.
- The gap reason is the bare code, like `evidence_not_found`, so the UI and the eval treat all rejections alike; the eval already counts any value turned into a gap as a rejection.
- `package.json` has no `engines` field, and none is added: pnpm refuses to install a project whose `engines.node` does not match, and Vercel builds the web app with Node 24 (handoff gotcha 42).
  The workflow pins Node 26 to match the Dockerfiles instead.
- The two stored real-model eval runs (24 calls) were re-checked against both new rules: no value would have been rejected.

## Acceptance criteria

- [ ] `packages/core/tests/evidence.test.ts`, against the parsed fixture text: a real quote with a wrong value gives `value_not_in_evidence`; a real quote containing its value is kept with `parsedText.slice(start, end) === evidence`; a value split across a line break inside the quote is kept; a quote shorter than 6 characters gives `evidence_too_short`.
- [ ] `packages/core/tests/carryOver.test.ts`: invoice v1 to v2 (parsed fixtures) leaves exactly `due_date` and `total_amount` pending; a short old quote does not carry over through the "still in the new text" rule.
- [ ] `apps/worker/tests/extract.test.ts`: a fake model returning a mismatched value stores a gap with reason `value_not_in_evidence`.
- [ ] No test constructs a real model client: `createLlm` is only called with a fake client, and every worker and api test passes a fake `Llm`.
- [ ] `pnpm turbo run lint typecheck build test` passes locally with the test database and Redis.
- [ ] The workflow YAML is checked (no `act` on this machine).

## Open questions

None; the user gave the requirements in full.
