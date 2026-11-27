# Handoff

Written 2026-11-27 for a new Claude session (different account, same machine and checkout).
Read this file first, then `spec/README.md`, then the spec you are asked to work on.

## Project in one paragraph

A document extraction service.
Users upload PDFs (invoices, leases, market reports).
It is the Lomi Labs take-home assignment (https://github.com/Lomi-Labs/take-home-assignment), due Saturday 2026-11-28 23:59 UTC; its README lists the required behaviors and the fixtures.
A worker extracts field values from each PDF version with an LLM, recording every attempt.
Humans review the values (approve or correct), and reviews carry forward when a new version of a document is uploaded.
Monorepo: pnpm 12 workspaces + turbo, TypeScript 7, Node 26, vitest, oxlint.

## Where things are

| Path | What |
|------|------|
| `apps/api` | Express 5 API. `POST /documents` (multipart upload), `GET /documents`, `GET /documents/:id` (with the current version's values), `GET /documents/:id/versions/:n`, `GET /documents/:id/progress`, `POST /documents/:id/retry`, `POST /values/:id/review`, `GET /health` (with version and queue counts). Also the seed (`src/seed.ts`). |
| `apps/worker` | BullMQ worker on queue `extraction`: claim with a heartbeat-renewed lease, parse, LLM, evidence check, commit (`src/extract.ts`); a reconciler re-enqueues from Postgres whatever Redis lost (`src/reconciler.ts`). |
| `apps/web` | Vite + React. Shows `/health` only. Served by nginx, which proxies `/health` to the api. |
| `packages/db` | Prisma 7 schema, migrations, `createDb()` client. |
| `packages/core` | Pure extraction logic: `extractPdfText` (unpdf), `buildPrompt`, `createLlm`, `parseLlmOutput`, `validateEvidence`. |
| `fixtures/` | Copied from the assignment repo: sample PDFs, `documents.json` manifest, `expected-fields.json`. |
| `docker-compose.yml` | postgres, redis, minio, minio-init, migrate-seed (migrations, then the fixture seed, from the api image), api, worker, web. |
| `scripts/chaos.sh` | Kills the worker and flushes Redis mid-extraction against the running stack, then checks everything settles. |
| `spec/` | Specs for spec-driven development. See `spec/README.md`. |

The legacy scaffolding (`JobStore`, `enqueue`, `processNext`, `createJob`, `packages/shared`) was deleted with spec 003.

## Git state

- PR https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/1 (specs 001 and 002, this `spec/` folder and `CLAUDE.md`) was merged into `main` on 2026-11-27 as `9e2eb42`.
- The `db-schema` branch is fully merged; do not add to it.
- PR https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/2 (spec 002 revision 2, spec 003 and spec 006, as 9 scoped commits that each pass the full check) was merged into `main` on 2026-11-27 as `cb16ebd`.
- The `upload-api` branch is fully merged; do not add to it.
- PR https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/3 (docs only: specs 002, 003 and 006 marked merged) was merged into `main` on 2026-11-27 as `9a988d2`.
- PR https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/4 (spec 007) was merged into `main` on 2026-11-27 as `703b84b`.
- The `extraction-resilience` branch is fully merged; do not add to it.
- Branch `review-api` (off `703b84b`) holds spec 004 revision 2, open for review as a PR. It was built in the worktree `../lomilabs-assignment-review-api` while another session worked in the main checkout.
- New work: branch off `main` and open a PR.
- Commits must be authored as `pradeepkundekar0101 <91021094+PradeepKundekar0101@users.noreply.github.com>`. The repo-local git config sets this; the machine's global identity is a different account.
- The repo has no CI. Verification is local only.

## Status

| Spec | State |
|------|-------|
| 001 Database schema | Done, merged to `main` (PR #1). |
| 002 PDF object storage, upload and document reads | Revision 1 merged (PR #1). Revision 2 done and verified in docker, merged (PR #2). |
| 003 Extraction worker (happy path) | Done and verified in docker with the real model, merged (PR #2). |
| 004 Review API | Revision 2 done and verified (integration tests, E2E in docker with the rebuilt api image), in review on branch `review-api`. |
| 005 New versions and carry-over | Draft. |
| 006 Seed the fixture documents | Done and verified in docker (`down -v`, `up`, `restart`), merged (PR #2). |
| 007 Extraction resilience (lease heartbeat, reconciler, attempt cap, retry, health counts) | Done and verified (integration tests, `scripts/chaos.sh`, retry and Redis-down checks in docker), merged (PR #4). |

Draft specs contain assumptions and open questions; confirm them with the user before implementing.

## How to run and verify

```bash
pnpm install
POSTGRES_PORT=5433 docker compose up -d --build --wait
TEST_DATABASE_URL=postgres://lomi:lomi@127.0.0.1:5433/lomi_test TEST_REDIS_URL=redis://127.0.0.1:6379/1 pnpm turbo run build typecheck lint test
./scripts/chaos.sh
```

Without `TEST_DATABASE_URL` and `TEST_REDIS_URL` the Postgres and Redis tests show as skipped.
Turbo migrates the test database before tests (`@lomi/db#migrate-test`, which also creates it).
The worker needs `ANTHROPIC_API_KEY` in `.env`; without it every extraction ends `failed` with `llm_request_failed`.

Smoke test an upload and its extraction:

```bash
curl -s -F type=invoice -F file=@fixtures/documents/invoice-001.pdf http://127.0.0.1:3000/documents
docker compose exec -T postgres psql -U lomi -d lomi -c 'select status, error from document_versions order by created_at desc limit 1'
```

On a fresh stack, `migrate-seed` seeds `doc-invoice-001`, `doc-lease-001` and `doc-report-001` (version 1 each) and the worker extracts them.
The stack was last rebuilt from empty volumes on 2026-11-27; after the spec 007 chaos and retry checks it runs with 11 documents, all `extracted`.
The api container was rebuilt from the `review-api` worktree on 2026-11-27 (`docker compose up --no-deps --force-recreate api`; plain `up --build` kept the old container). The spec 004 E2E left reviews on two non-fixture documents, `c7dfe635…` and `d5c9a499…`; the three seeded documents have none.
The api service has no healthcheck, so `docker compose up --wait` returns before it listens; give it a second before the first request.

## Gotchas found so far (read these, they cost time)

1. **Port 5432 is taken on this machine.** Run compose with `POSTGRES_PORT=5433`. The user's `.env` still says 5432; do not edit `.env` without asking.
2. **Stale one-shot containers.** After a failed `docker compose up --build`, a later `up --build` reused the old `migrate` container, so a new migration did not run. Check `docker inspect lomi-migrate-seed-1 --format '{{.Image}}'` against `docker image inspect lomi-migrate-seed --format '{{.Id}}'`, or check `_prisma_migrations`, after any migration change.
3. **npm registry is flaky from inside Docker builds** (timeouts, a DNS failure). A failed `pnpm deploy` step is usually network; retry before debugging.
4. **pnpm 12 fails installs on unlisted build scripts.** `pnpm-workspace.yaml` `allowBuilds` lists `prisma`, `@prisma/engines`, `esbuild` (true) and `msgpackr-extract` (false). Add new entries there when a dependency has an install script.
5. **Prisma is pinned to exactly 7.10.1** (`prisma`, `@prisma/client`, `@prisma/adapter-pg`). The npm `latest` tag pointed at an 8.0 release candidate. Ignore the CLI's "update available" banner.
6. **Prisma 7 specifics.** Config lives in `packages/db/prisma.config.ts` (datasource URL from `DATABASE_URL`). Generator is `prisma-client` writing TypeScript to `packages/db/src/generated` (gitignored), produced by the turbo `generate` task before build/typecheck/test. Queries need the `@prisma/adapter-pg` driver adapter, which `createDb()` sets up.
7. **Prisma cannot express CHECK constraints.** Add them by hand to the migration SQL (see the init migration). To generate a migration without a shadow DB: `git show HEAD:packages/db/prisma/schema.prisma > /tmp/old.prisma` then `prisma migrate diff --from-schema /tmp/old.prisma --to-schema prisma/schema.prisma --script`. Redirect stderr, or the update banner can end up in your output.
8. **Never edit an applied migration.** Add a new one; the local DB has both migrations applied.
9. **MinIO images.** Docker Hub and quay no longer serve MinIO. Compose uses `cgr.dev/chainguard/minio` and `cgr.dev/chainguard/minio-client`, pinned by digest. The server image has bash but no curl or grep (hence the `/dev/tcp` healthcheck). The client image has no shell, so `minio-init` uses the `MC_HOST_local` env var.
10. **Fetch with a Buffer body** fails typecheck under these Node types; tests send strings, and the api copies into a `Uint8Array` before `new Response(...)`.
11. **Disk space.** On 2026-11-27 `docker builder prune -f` freed 14 GB again (host back to 13 GB free); the next image build re-downloads every npm package. Earlier: the machine runs close to full and Docker Desktop's disk image is about 27 GB. A `docker compose up --build` filled the disk twice on 2026-11-27, which left Docker hung (`docker info` never answers) and Postgres and Redis broken (`/health` 503). Check `df -h /System/Volumes/Data` before building; after a disk-full, free space and restart Docker Desktop. `docker builder prune -f` freed 13 GB.
12. **Docker restarts old containers.** `restart: unless-stopped` brings the previous images back when Docker Desktop restarts, so the running stack can be older than the code. Rebuild after a Docker restart.
13. **pdf.js detaches its input.** `getDocumentProxy` transfers the `Uint8Array`'s buffer; `extractPdfText` passes a copy so callers can reuse their bytes.
14. **No `temperature` on current models.** `claude-opus-5-5` rejects sampling parameters and forced `tool_choice` with a 400; the worker uses structured output and explicit `effort` instead. Load the `claude-api` skill before touching `packages/core/src/llm.ts`.
15. **Turbo filters environment variables.** A variable a task needs (like `TEST_DATABASE_URL`) must be listed under that task's `env` in `turbo.json`.
16. **The enum value is `market_report`, not `report`,** to match the fixtures.
17. **Document ids are text, other ids are uuid.** Seeded documents use the manifest's ids (`doc-invoice-001`). Never cast a document id with `::uuid` in raw SQL; version, value, run and review ids are still `uuid`.
18. **The seed test uses prefixed ids.** Test files share the test database, so `seed.test.ts` seeds the manifest under `test-<uuid>-` ids and deletes only those.
19. **Tests need their own database and Redis database.** The compose worker's reconciler enqueues every `queued` or lease-expired version in its database, so test rows in the compose `lomi` database get extracted (and failed) by the real worker. Use `lomi_test` and Redis database 1. The resilience tests' reconciler only enqueues their own versions, because other test files run in parallel against `lomi_test`.
20. **BullMQ ignores adding a `jobId` it still holds.** Every producer adds extract jobs with `removeOnComplete` and `removeOnFail`; a kept finished job would silently swallow every retry and reconcile of that version.
21. **A dead worker's job comes back before its lease expires.** BullMQ's stalled check (30 s lock) re-runs it, the claim refuses it (lease 60 s), and the reconciler resumes the version once the lease has expired. Tests keep that ratio (lease 1.5 s, lock 0.5 s).
22. **The `documents` row lock orders reviews and new versions.** A review, the worker's commit and (through its foreign-key insert) an upload all take the document row first. A review's `created_at` is `clock_timestamp()` so "latest review" follows that lock order; keep both if you touch reviews or carry-over.
23. **The api needs `EXPECTED_FIELDS_PATH`** (for the values' sort order), like the worker; both Dockerfiles set it.

## User preferences (from the user's global instructions)

- Never use the em dash character. Use a plain dash.
- No AI co-author lines in commit messages.
- In long Markdown files, one sentence per line.
- Prefer quality, simplicity and long-term maintainability over development cost.
- Bug fixes start by reproducing the bug end to end, as a user would hit it.
- Fix lint errors, test failures and flakiness you come across, even if unrelated.
- Be picky about UI when testing end to end.
- Commit or push only when asked; branch off `main` first.
