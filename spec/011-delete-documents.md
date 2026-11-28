# 011 Delete documents

Status: Done (verified 2026-11-28; merged in PR #14)
Depends on: 001, 004, 005, 007, 008

## Goal

A reviewer can delete a document from the document list or from its page.
A deleted document is gone from the app and the API, while its history stays in the database.

## Requirements

### 1. Data

1. `documents.deleted_at` (timestamptz, nullable) marks a deleted document; a migration adds it.
2. Deleting removes nothing: versions, extraction runs, values, reviews and the PDF objects stay (reviews stay append-only, spec 001).

### 2. API

1. `DELETE /documents/:id` answers `204` with no body, and `404` for an unknown or already deleted document.
2. Under the document lock (the one uploads, reviews and the worker's commit take), it sets `deleted_at` and turns the document's `queued` and `extracting` versions into `superseded` with no lease.
3. A deleted document is not found everywhere else:
   - `GET /documents` leaves it out.
   - `GET /documents/:id`, `GET /documents/:id/versions/:n` and `GET /documents/:id/progress` are `404`.
   - `POST /documents/:id/versions` and `POST /documents/:id/retry` are `404`.
   - `POST /values/:id/review` on one of its values is `404`, checked under the document lock, so a review never lands after the delete.
4. The CORS preflight for the review UI on another origin allows `DELETE`.

### 3. Worker

1. The check that a version is still current (before the model call, and at commit under the document lock) treats a deleted document as not current, so its version ends `superseded` with no values, as when a newer version replaced it.
2. A version the delete marked `superseded` is no longer claimable, and the reconciler does not re-enqueue it.

### 4. UI

1. Each row of the document list has a trash icon button labelled "Delete <title>".
2. The document page header has a "Delete" button next to "Upload new version"; on phones it is a square icon button (still named "Delete"), so both fit one row.
3. Both open one confirmation Dialog: "Delete document?", naming the document and saying it cannot be restored from the app; Cancel, and a destructive Delete that is disabled while the request runs.
4. On success: a toast "<title> deleted", the row leaves the list at once, and the document page goes back to the list.
5. A failure shows the API's message inline in the Dialog, which stays open.

## Out of scope

- Restoring a deleted document (no undo, no restore endpoint).
- Erasing rows or PDF objects (hard delete), and a retention job that purges deleted documents later.
- Deleting a single version.
- Authentication: anyone who can open the app can delete, as anyone can review.

## Design notes

- Soft delete, chosen by the user over hard delete.
  A hard delete would break append-only reviews, and PDF objects are content-addressed (`pdfs/<sha256>.pdf`), so one object can back several documents and could only go once no version points at it.
- The seed skips a manifest id that exists, and a deleted document still exists, so a deleted fixture stays deleted across `docker compose up`.
- Delete marks in-flight versions `superseded`, not `failed`: nothing went wrong, and the worker already treats `superseded` as stopped without values.
  A worker mid-attempt sees the document as not current at its next check and supersedes itself; its heartbeat only renews `extracting` versions, so it stops.
- `/health` counts every version row, including a deleted document's.
- `DELETE` answers `204`; the web client parses the empty body as `null`.
- A retry does not take the document lock, so one racing a delete can queue a version of the deleted document once; the worker then finds the document deleted before the model call and supersedes it.
- The success toast and the list update run in the mutation hook, not in the dialog's `mutate` callback: the deleted row (and its dialog) unmounts before that callback would run.

## Acceptance criteria

- [x] Integration against Postgres (`apps/api/tests/delete.test.ts`, over HTTP with the real `createVersion` and `retryDocument`): a delete hides the document from the list, view, version view and progress; a second delete, a new version, a retry and a review of its value are not found; its queued version becomes `superseded`; its versions, values and reviews are still in the database.
- [x] Worker integration (`apps/worker/tests/extract.test.ts`): a document deleted while the model runs ends `superseded` with no values, and one deleted before the call skips the model.
- [x] Route (`apps/api/tests/app.test.ts`): the CORS preflight allows `DELETE`.
- [x] Component (`apps/web/tests/DeleteDocument.test.tsx`, MSW): deleting from the list asks first, sends `DELETE`, and removes the row; deleting from the page goes back to the list; a failed delete shows the message in the Dialog.
- [x] E2E in docker (api, worker, web and migrate-seed images rebuilt; the migration applied): two uploaded copies of the lease fixture, `e2e-delete-list.pdf` deleted from the list and `e2e-delete-page.pdf` from its page; each showed the toast, left the list, the page one went back to the list, and its URL shows "Not found"; both rows are still in Postgres with `deleted_at` set and their 5 values each.
  Both copies had finished extracting before the delete, so stopping an in-flight extraction is covered by the integration tests only.
  Checked at desktop and phone width; found and fixed the page header's Upload and Delete buttons wrapping onto two uneven lines on phones.

## Open questions

Answered 2026-11-28: soft delete (hide, keep history); a Delete action both in the list rows and the document page header; a document can be deleted while extracting, which stops the extraction; no undo, a confirmation dialog first.
