# Handoff

Written 2026-11-27 for a new Claude session (different account, same machine and checkout).
Read this file first, then `spec/README.md`, then the spec you are asked to work on.

## Project in one paragraph

A document extraction service.
Users upload PDFs (invoices, leases, reports).
A worker extracts field values from each PDF version with an LLM, recording every attempt.
Humans review the values (approve or correct), and reviews carry forward when a new version of a document is uploaded.
Monorepo: pnpm 12 workspaces + turbo, TypeScript 7, Node 26, vitest, oxlint.

## Where things are

| Path | What |
|------|------|
| `apps/api` | Express 5 API. `POST /documents` upload, `GET /health`. |
| `apps/worker` | BullMQ worker on queue `extraction`. Currently only logs the job. |
| `apps/web` | Vite + React. Shows `/health` only. Served by nginx, which proxies `/health` to the api. |
| `packages/db` | Prisma 7 schema, migrations, `createDb()` client. |
| `packages/core`, `packages/shared` | Original scaffolding (`createJob`, `Job`, `createId`). |
| `docker-compose.yml` | postgres, redis, minio, minio-init, migrate, api, worker, web. |
| `spec/` | Specs for spec-driven development. See `spec/README.md`. |

Legacy scaffolding still present and unused by the new flow: `JobStore` (in-memory, `packages/db/src/index.ts`), `enqueue` in `apps/api/src/index.ts`, `processNext` in `apps/worker/src/index.ts`.
They have tests and are imported only by those tests.
Delete them once spec 003 replaces the worker logic.

## Git state

- Branch `db-schema`, pushed, open as PR https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/1 (base `main`).
- Commit `04c60c1` on that branch holds spec 001 plus the earlier Docker/api/web scaffold.
- **Spec 002 is implemented and verified but NOT committed.** Uncommitted files:
  `.env.example`, `apps/api/package.json`, `apps/api/src/{app.ts,app.test.ts,main.ts,upload.ts,upload.test.ts}`, `docker-compose.yml`, `packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/20261126120000_pdf_object_storage/`, `pnpm-lock.yaml`.
  Ask the user before committing; then commit on `db-schema` and push so it lands in PR #1.
- The repo has no CI. Verification is local only.

## Status

| Spec | State |
|------|-------|
| 001 Database schema | Done, committed, in PR #1. |
| 002 PDF object storage and upload | Done and verified end to end, uncommitted. |
| 003 Extraction worker | Draft. Next to build. |
| 004 Review API | Draft. |
| 005 New versions and carry-over | Draft. |

Draft specs contain assumptions and open questions; confirm them with the user before implementing.

## How to run and verify

```bash
pnpm install
pnpm turbo run build typecheck lint test
POSTGRES_PORT=5433 docker compose up -d --build --wait
```

Smoke test the upload:

```bash
curl -s -X POST -H 'content-type: application/pdf' --data-binary @some.pdf 'http://127.0.0.1:3000/documents?type=invoice&title=Test'
docker compose exec -T postgres psql -U lomi -d lomi -c '\d document_versions'
```

The stack was left running at handoff time.

## Gotchas found so far (read these, they cost time)

1. **Port 5432 is taken on this machine.** Run compose with `POSTGRES_PORT=5433`. The user's `.env` still says 5432; do not edit `.env` without asking.
2. **Stale one-shot containers.** After a failed `docker compose up --build`, a later `up --build` reused the old `migrate` container, so a new migration did not run. Check `docker inspect lomi-migrate-1 --format '{{.Image}}'` against `docker image inspect lomi-migrate --format '{{.Id}}'`, or check `_prisma_migrations`, after any migration change.
3. **npm registry is flaky from inside Docker builds** (timeouts, a DNS failure). A failed `pnpm deploy` step is usually network; retry before debugging.
4. **pnpm 12 fails installs on unlisted build scripts.** `pnpm-workspace.yaml` `allowBuilds` lists `prisma`, `@prisma/engines`, `esbuild` (true) and `msgpackr-extract` (false). Add new entries there when a dependency has an install script.
5. **Prisma is pinned to exactly 7.10.1** (`prisma`, `@prisma/client`, `@prisma/adapter-pg`). The npm `latest` tag pointed at an 8.0 release candidate. Ignore the CLI's "update available" banner.
6. **Prisma 7 specifics.** Config lives in `packages/db/prisma.config.ts` (datasource URL from `DATABASE_URL`). Generator is `prisma-client` writing TypeScript to `packages/db/src/generated` (gitignored), produced by the turbo `generate` task before build/typecheck/test. Queries need the `@prisma/adapter-pg` driver adapter, which `createDb()` sets up.
7. **Prisma cannot express CHECK constraints.** Add them by hand to the migration SQL (see the init migration). To generate a migration without a shadow DB: `git show HEAD:packages/db/prisma/schema.prisma > /tmp/old.prisma` then `prisma migrate diff --from-schema /tmp/old.prisma --to-schema prisma/schema.prisma --script`. Redirect stderr, or the update banner can end up in your output.
8. **Never edit an applied migration.** Add a new one; the local DB has both migrations applied.
9. **MinIO images.** Docker Hub and quay no longer serve MinIO. Compose uses `cgr.dev/chainguard/minio` and `cgr.dev/chainguard/minio-client`, pinned by digest. The server image has bash but no curl or grep (hence the `/dev/tcp` healthcheck). The client image has no shell, so `minio-init` uses the `MC_HOST_local` env var.
10. **Fetch with a Buffer body** fails typecheck under these Node types; tests send strings.

## User preferences (from the user's global instructions)

- Never use the em dash character. Use a plain dash.
- No AI co-author lines in commit messages.
- In long Markdown files, one sentence per line.
- Prefer quality, simplicity and long-term maintainability over development cost.
- Bug fixes start by reproducing the bug end to end, as a user would hit it.
- Fix lint errors, test failures and flakiness you come across, even if unrelated.
- Be picky about UI when testing end to end.
- Commit or push only when asked; branch off `main` first.
