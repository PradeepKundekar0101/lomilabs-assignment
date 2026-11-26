# 002 PDF object storage and upload

Status: Done (commit `afda8d6`, PR #1)
Depends on: 001

## Goal

PDF bytes live in S3-compatible object storage (MinIO locally), never in Postgres, and uploads are ordered so a row never points at a missing object.

## Requirements

1. `document_versions` has no `pdf` column. It has `storage_key`, `sha256`, `size_bytes`, `mime_type`, all NOT NULL.
2. MinIO runs in docker-compose with a named volume (`minio-data`) and a one-shot `minio-init` service that creates the bucket.
3. The api reads `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` from the environment and fails fast if any is missing.
4. Upload order: put object at `pdfs/<sha256>.pdf`, then insert rows in one transaction, then enqueue.
5. A row is never inserted before its object exists.

## What was built

- Migration `20261126120000_pdf_object_storage` (a new migration, because `init` was already applied locally).
- `POST /documents?type=<invoice|lease|report>&title=<text>` with the raw PDF as the body and `Content-Type: application/pdf`. Returns `201 {documentId, versionId}`.
  - Validation: `400` for an unknown type, a missing title, or a body that does not start with `%PDF-`; `415` for the wrong content type; `413` above 25 MB.
- `apps/api/src/upload.ts` `uploadDocument(deps, input)`:
  1. sha256 of the bytes; key `pdfs/<sha256>.pdf` (content addressed, so identical re-uploads rewrite the same object).
  2. `putObject`. If it throws, nothing else happens and the route returns 500.
  3. One `$transaction`: create document, create version 1, set `documents.current_version_id`.
  4. Enqueue BullMQ job `extract` on queue `extraction` with `{versionId}` and `jobId = versionId` (a repeated enqueue is a no-op).
  5. If enqueue fails, log and still return 201: the committed `queued` row is the source of truth, and a 500 would make clients retry into a duplicate document.
- MinIO via Chainguard images pinned by digest (Docker Hub and quay no longer serve MinIO). Dev only: the MinIO root user doubles as the app's S3 credentials (`lomi` / `lomisecret` by default).
- The api health check now uses Prisma (`SELECT 1`); the api no longer depends on `pg` directly.

## Out of scope (left for later specs)

- New versions of an existing document (`version_no` is always 1). See 005.
- Re-enqueueing versions stuck in `queued` after an enqueue failure. See 003.
- Download or read-back of the PDF (the worker will need it; see 003).
- Configurable size limit and S3 region (hard-coded 25 MB and `us-east-1`).

## Acceptance criteria

- [x] Unit tests in `upload.test.ts` assert the exact call order put, begin, inserts, commit, enqueue.
- [x] A failed put inserts nothing; a failed transaction does not enqueue; a failed enqueue still returns the result.
- [x] Route tests in `app.test.ts` cover 201 and the 400/415 rejections.
- [x] End to end in docker: upload returned 201; the object exists in MinIO with `Content-Type: application/pdf`; the rows hold the right key, hash and size; `current_version_id` is set; the Redis job exists; the worker logged it.
- [x] End to end with MinIO stopped: 500, and the document and version counts were unchanged.
- [x] `minio-init` is idempotent (re-run exits 0).

## Open questions

- Should a duplicate upload (same sha256) for the same document be rejected or deduplicated?
- Production credentials: a dedicated MinIO/S3 user with bucket-scoped policy instead of root.
