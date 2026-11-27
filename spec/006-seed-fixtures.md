# 006 Seed the fixture documents

Status: Done (verified 2026-11-27 on branch `upload-api`, not yet committed; requirements given by the user)
Depends on: 002, 003

## Goal

`docker compose up` on an empty stack seeds version 1 of each fixture document through the real upload path, so reviewers can click around immediately.
Restarting or re-running adds nothing.

## Requirements

1. Source: `fixtures/documents.json` (each document's `id`, `type`, `title`, `versions`) and the PDFs in `fixtures/documents/`.
   The fixtures are a byte-identical copy of the assignment repo's `fixtures/` folder.
2. Seed only version 1 of each document.
   Never seed the invoice's version 2; it exists to exercise re-extraction by upload.
3. Each document goes through the same `createVersion` service the upload endpoint uses: MinIO put, then one transaction, then enqueue.
   The seed never writes rows directly.
4. The document id is the manifest's id (`doc-invoice-001`), and the title is the manifest's title.
5. Idempotent: a document whose id already exists is skipped, so running the seed twice, or restarting the stack, creates no documents or versions.
6. One log line per document: `seed: <id> seeded, version <versionId> <status>` or `seed: <id> skipped, already exists`.
7. A failed enqueue is logged and the seed continues; the row stays `queued` for the reconciler (a later spec).
8. A missing `ANTHROPIC_API_KEY` does not affect the seed; the worker then fails each extraction with `llm_request_failed`, retryable once the key is set.
9. Compose: the one-shot `migrate` service becomes `migrate-seed`, which runs migrations and then the seed.
   It waits for healthy `postgres` and `redis` and a completed `minio-init`, and mounts `./fixtures` read-only.
   `api` and `worker` wait for it with `service_completed_successfully`.

## Out of scope

- `POST /documents/:id/versions` for uploading the invoice's version 2 (spec 005).
- The reconciler that re-enqueues `queued` rows whose job was lost.

## Design notes

- **Document ids are text.**
  `documents.id` (and `document_versions.document_id`) changed from `uuid` to `text` (migration `20261127180000_text_document_ids`), so seeded documents keep the manifest's ids and `GET /documents/doc-invoice-001` works.
  Uploads still get a database-generated uuid, stored as text.
  Version, value, run and review ids stay `uuid`.
  `GET /documents/:id` no longer rejects non-uuid ids up front; an unknown id is a plain `404`.
- `createVersion(deps, target, file)` takes a target: `{documentId}` for a new version of an existing document, or `{id?, type, title}` for a new document.
  The upload route passes `{type, title: file.name}`; the seed passes the manifest's `{id, type, title}`.
- The seed lives in `apps/api/src/seed.ts` because it needs the api's `createVersion`.
  `apps/api/src/services.ts` builds the database, S3 and queue dependencies for both `main.ts` and the seed, so they cannot drift.
- `migrate-seed` runs the api image: `@lomi/db` in that image already carries the migrations, `prisma.config.ts` and the Prisma CLI.
  `packages/db/Dockerfile` (the old `migrate` image) was deleted.
- The api's queue fails fast while Redis is not connected yet, so the seed waits up to 10 s for the queue connection before seeding; otherwise its first enqueue could race the connection and be dropped.
- Seeding the same id concurrently would make one run fail on the primary key; only one `migrate-seed` runs, so this is not handled.

## Acceptance criteria

- [x] Postgres test (`seed.test.ts`, real `createVersion`, fake storage and queue): running the seed twice gives one document per manifest entry (3), each with exactly one version (`version_no` 1, `queued`, current), with the manifest's type and title; each document is stored and enqueued once; the second run logs `skipped` for all.
      The test uses the real manifest under prefixed ids, so it does not collide with the stack's seeded documents.
- [x] Same test: the seeded invoice's `sha256` equals the sha256 of `invoice-001.pdf` and not of `invoice-001.v2.pdf`.
- [x] Unit: `createVersion` creates a document under a chosen id.
- [x] E2E: `POSTGRES_PORT=5433 docker compose down -v && docker compose up -d --build --wait` applied all 4 migrations, logged `seeded` for the 3 documents, exited 0, and all 3 reached `extracted` with the real model and no manual steps.
      The invoice's stored sha256 starts `7d381089856b`, matching the v1 fixture.
- [x] E2E: `docker compose restart` re-ran `migrate-seed`, which logged `skipped` for all 3 and exited 0; the stack still had 3 documents, 3 versions and 3 extraction runs.
- [x] E2E: `GET /documents` lists `doc-invoice-001`, `doc-lease-001`, `doc-report-001`, and `GET /documents/doc-invoice-001` returns `200`.

## Open questions

None.
The request said "4 documents"; the manifest has 3 documents and 4 PDFs (the invoice has a version 2), so the seed creates 3.
