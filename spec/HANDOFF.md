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
| `apps/api` | Express 5 API. `POST /documents` (multipart upload), `GET /documents`, `GET /documents/:id`, `GET /health`. Also the seed (`src/seed.ts`). |
| `apps/worker` | BullMQ worker on queue `extraction`: claim with a lease, parse, LLM, evidence check, commit (`src/extract.ts`). |
| `apps/web` | Vite + React. Shows `/health` only. Served by nginx, which proxies `/health` to the api. |
| `packages/db` | Prisma 7 schema, migrations, `createDb()` client. |
| `packages/core` | Pure extraction logic: `extractPdfText` (unpdf), `buildPrompt`, `createLlm`, `parseLlmOutput`, `validateEvidence`. |
| `fixtures/` | Copied from the assignment repo: sample PDFs, `documents.json` manifest, `expected-fields.json`. |
| `docker-compose.yml` | postgres, redis, minio, minio-init, migrate-seed (migrations, then the fixture seed, from the api image), api, worker, web. |
| `spec/` | Specs for spec-driven development. See `spec/README.md`. |

The legacy scaffolding (`JobStore`, `enqueue`, `processNext`, `createJob`, `packages/shared`) was deleted with spec 003.

## Git state

- PR https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/1 (specs 001 and 002, this `spec/` folder and `CLAUDE.md`) was merged into `main` on 2026-11-27 as `9e2eb42`.
- The local checkout is on `main`, up to date with `origin/main`.
- The `db-schema` branch is fully merged; do not add to it.
- PR https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/2 (spec 002 revision 2, spec 003 and spec 006, as 9 scoped commits that each pass the full check) was merged into `main` on 2026-11-27 as `cb16ebd`.
- The `upload-api` branch is fully merged; do not add to it.
- New work: branch off `main` and open a PR.
- Commits must be authored as `pradeepkundekar0101 <91021094+PradeepKundekar0101@users.noreply.github.com>`. The repo-local git config sets this; the machine's global identity is a different account.
- The repo has no CI. Verification is local only.

## Status

| Spec | State |
|------|-------|
| 001 Database schema | Done, merged to `main` (PR #1). |
| 002 PDF object storage, upload and document reads | Revision 1 merged (PR #1). Revision 2 done and verified in docker, merged (PR #2). |
| 003 Extraction worker (happy path) | Done and verified in docker with the real model, merged (PR #2). Sweeper, retry and carry-over are later specs. |
| 004 Review API | Draft. |
| 005 New versions and carry-over | Draft. |
| 006 Seed the fixture documents | Done and verified in docker (`down -v`, `up`, `restart`), merged (PR #2). |

Draft specs contain assumptions and open questions; confirm them with the user before implementing.

## How to run and verify

```bash
pnpm install
POSTGRES_PORT=5433 docker compose up -d --build --wait
TEST_DATABASE_URL=postgres://lomi:lomi@127.0.0.1:5433/lomi pnpm turbo run build typecheck lint test
```

Without `TEST_DATABASE_URL` the worker's Postgres tests show as skipped.
The worker needs `ANTHROPIC_API_KEY` in `.env`; without it every extraction ends `failed` with `llm_request_failed`.

Smoke test an upload and its extraction:

```bash
curl -s -F type=invoice -F file=@fixtures/documents/invoice-001.pdf http://127.0.0.1:3000/documents
docker compose exec -T postgres psql -U lomi -d lomi -c 'select status, error from document_versions order by created_at desc limit 1'
```

On a fresh stack, `migrate-seed` seeds `doc-invoice-001`, `doc-lease-001` and `doc-report-001` (version 1 each) and the worker extracts them.
The stack was last rebuilt from empty volumes on 2026-11-27 and left running with only those 3 seeded documents.

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
11. **Disk space.** The machine runs close to full and Docker Desktop's disk image is about 27 GB. A `docker compose up --build` filled the disk twice on 2026-11-27, which left Docker hung (`docker info` never answers) and Postgres and Redis broken (`/health` 503). Check `df -h /System/Volumes/Data` before building; after a disk-full, free space and restart Docker Desktop. `docker builder prune -f` freed 13 GB.
12. **Docker restarts old containers.** `restart: unless-stopped` brings the previous images back when Docker Desktop restarts, so the running stack can be older than the code. Rebuild after a Docker restart.
13. **pdf.js detaches its input.** `getDocumentProxy` transfers the `Uint8Array`'s buffer; `extractPdfText` passes a copy so callers can reuse their bytes.
14. **No `temperature` on current models.** `claude-opus-5-5` rejects sampling parameters and forced `tool_choice` with a 400; the worker uses structured output and explicit `effort` instead. Load the `claude-api` skill before touching `packages/core/src/llm.ts`.
15. **Turbo filters environment variables.** A variable a task needs (like `TEST_DATABASE_URL`) must be listed under that task's `env` in `turbo.json`.
16. **The enum value is `market_report`, not `report`,** to match the fixtures.
17. **Document ids are text, other ids are uuid.** Seeded documents use the manifest's ids (`doc-invoice-001`). Never cast a document id with `::uuid` in raw SQL; version, value, run and review ids are still `uuid`.
18. **The seed test uses prefixed ids.** Tests share the compose database, so `seed.test.ts` seeds the manifest under `test-<uuid>-` ids and deletes only those.

## User preferences (from the user's global instructions)

- Never use the em dash character. Use a plain dash.
- No AI co-author lines in commit messages.
- In long Markdown files, one sentence per line.
- Prefer quality, simplicity and long-term maintainability over development cost.
- Bug fixes start by reproducing the bug end to end, as a user would hit it.
- Fix lint errors, test failures and flakiness you come across, even if unrelated.
- Be picky about UI when testing end to end.
- Commit or push only when asked; branch off `main` first.
