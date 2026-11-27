# 002 PDF object storage, upload and document reads

Status: Done (revision 2, verified 2026-11-27 on branch `upload-api`, not yet committed; revision 1 was commit `afda8d6`, PR #1)
Depends on: 001

## Goal

PDF bytes live in S3-compatible object storage (MinIO locally), never in Postgres, and uploads are ordered so a row never points at a missing object.
Clients can list documents and read one document with its current version, without ever receiving PDF bytes.

## Requirements

1. `document_versions` has no `pdf` column. It has `storage_key`, `sha256`, `size_bytes`, `mime_type`, all NOT NULL.
2. MinIO runs in docker-compose with a named volume (`minio-data`) and a one-shot `minio-init` service that creates the bucket.
3. The api reads `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` from the environment and fails fast if any is missing.
4. `POST /documents` takes `multipart/form-data` with fields `type` and `file`.
   - `400` unless `type` is `invoice | lease | report`, `file` is a file part, the file starts with `%PDF-`, and it is at most 10 MB.
   - `415` when the body is not `multipart/form-data`.
   - The document title is the uploaded file's name.
5. Steps after validation live in one reusable service, `createVersion(documentId | null, file, type)`:
   1. sha256 the file; key `pdfs/<sha256>.pdf`.
   2. Put the object. If that fails, respond `503` and write nothing.
   3. In one transaction: insert the document (when `documentId` is null), insert the version (`status = queued`, `storage_key`, `sha256`, `size_bytes`, `mime_type`), and set `documents.current_version_id`.
   4. Enqueue BullMQ job `extract` on queue `extraction` with data `{versionId}` and `jobId = versionId`. If enqueue fails, log it and still succeed; the row stays `queued` for the reconciler (003).
6. A successful upload responds `202 {id, versionId, status: "queued"}` without waiting for extraction.
7. `GET /documents/:id` returns the document, its current version (`id`, `versionNo`, `status`, `error`, `attempts`, `createdAt`) and `values: []`. `404` when the document does not exist (including ids that are not UUIDs).
8. `GET /documents` returns a list of `{id, title, type, versionNo, status}` from each document's current version, newest first.
9. No endpoint returns PDF bytes.

## Design notes

- Multipart is parsed with Node's built-in `Response.formData()` on a body buffered by `express.raw` (capped just above 10 MB), so no multipart dependency is added.
  A body over the cap is answered `400` like any other oversized file.
- The put failure is wrapped in a `StorageUnavailableError` so the route can tell it apart from database failures (`500`).
- The BullMQ producer fails fast so an upload never waits on Redis:
  - `enableOfflineQueue: false` on its connection covers Redis going down after the api started. With the offline queue on, `queue.add` waits for Redis to come back.
  - `skipWaitingForReady: true` covers the api starting while Redis is down. Without it BullMQ holds every command until the first connection is ready, and the upload hung past 20 seconds in the E2E run.
  - `skipVersionCheck: true` is required with the previous option, because the version check's `INFO` would fail that first connection permanently.
- `createVersion` with a non-null `documentId` gives the next `version_no`, marks the previous current version `superseded`, and moves `current_version_id`.
  No route calls it yet; spec 005 adds `POST /documents/:id/versions`, the retry for the concurrent-upload race on `(document_id, version_no)`, and carry-over.
- `values` is always `[]` until extraction (003) and the review API (004) exist; 004 fills it.
- Content addressed keys: re-uploading identical bytes rewrites the same object.
- MinIO via Chainguard images pinned by digest (Docker Hub and quay no longer serve MinIO). Dev only: the MinIO root user doubles as the app's S3 credentials (`lomi` / `lomisecret` by default).
- The api health check uses Prisma (`SELECT 1`).

## Changes from revision 1

| | Revision 1 | Revision 2 |
|---|---|---|
| Request | Raw PDF body, `type` and `title` in the query string | `multipart/form-data` with `type` and `file` |
| Title | `title` query parameter | The file's name |
| Size limit | 25 MB, `413` | 10 MB, `400` |
| Object storage down | `500` | `503` |
| Success | `201 {documentId, versionId}` | `202 {id, versionId, status: "queued"}` |
| Reads | None | `GET /documents`, `GET /documents/:id` |

## Out of scope (left for later specs)

- A route for new versions of an existing document, and carry-over. See 005.
- Re-enqueueing versions stuck in `queued` after an enqueue failure. See 003.
- Download or read-back of the PDF (the worker will need it; see 003).
- Pagination of `GET /documents`.
- Configurable size limit and S3 region (hard-coded 10 MB and `us-east-1`).

## Acceptance criteria

- [x] Unit (`create-version.test.ts`): the call order is put, begin, inserts, commit, enqueue, and the version row is `queued` with the right key, hash and size.
- [x] Unit: a failed put throws `StorageUnavailableError` and touches no rows; a failed transaction does not enqueue; a failed enqueue still returns `queued`.
- [x] Unit: a new version of an existing document gets the next `version_no` and supersedes the previous current version.
- [x] Route (`app.test.ts`): a valid upload returns `202 {id, versionId, status: "queued"}`; non-PDF, unknown type, missing file and oversized file return `400`; a non-multipart body returns `415`; storage failure returns `503`.
- [x] Route: `GET /documents/:id` returns the shape above, `404` for a missing or malformed id; `GET /documents` returns the list shape.
- [x] E2E in docker: a valid upload returned `202` in 0.14 s; the object exists in MinIO with `Content-Type: application/pdf`; the row is `queued` with the right key, hash and size and is the current version; the Redis job exists; the worker logged it.
- [x] E2E: non-PDF, unknown type, file over 10 MB, missing file, `file` sent as a text field and malformed multipart each returned `400`; a raw `application/pdf` body returned `415`; no rows were written.
- [x] E2E: with MinIO stopped, `503` in 0.17 s and the document and version counts were unchanged; the same file returned `202` once MinIO was back.
- [x] E2E: with Redis stopped after the api started, `202` in 0.016 s, the row is `queued`, the api logged the enqueue failure; after Redis was back, the next upload's job was enqueued.
- [x] E2E: with the api started while Redis is down, `202` in 0.07 s and the row is `queued`. Before the `skipWaitingForReady` fix it hung past 20 s.
- [x] E2E: `GET /documents` lists `{id, title, type, versionNo, status}` newest first; `GET /documents/:id` returns the document, its current version and `values: []`; `404` for a missing and a malformed id; no response contains PDF bytes.
- [x] E2E re-run on the final image: non-PDF and over 10 MB `400`; MinIO down `503` with counts unchanged; Redis down `202` in 0.17 s with the row `queued`.

## Open questions

- Should a duplicate upload (same sha256) for the same document be rejected or deduplicated? (Also 005 question 3.)
- Production credentials: a dedicated MinIO/S3 user with bucket-scoped policy instead of root.
