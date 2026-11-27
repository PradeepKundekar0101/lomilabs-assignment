# 008 Review UI

Status: Done (from the user's requirements on 2026-11-27; verified 2026-11-27; in review on branch `review-ui`)
Depends on: 002, 004, 005, 007

## Goal

A reviewer can see every document, upload documents and new versions, and approve or correct each extracted value with its evidence in view.
After a new version is extracted, what changed is at the top with the previous value and its review beside it, and everything else is visibly carried over.
Clarity matters more than polish.

## Requirements

### 0. Setup (`apps/web`)

1. Vite + React + TypeScript, TanStack Query, Tailwind CSS v4 (`@tailwindcss/vite`, `@import "tailwindcss";` in `src/index.css`), shadcn/ui, React Router with two routes: `/` and `/documents/:id`.
2. Path alias `@/*` to `src/*` in `tsconfig.json`, `tsconfig.app.json` and `vite.config.ts`.
3. shadcn components, added with the shadcn CLI into `src/components/ui` and not edited except for theme tokens: button, badge, table, card, input, textarea, label, select, dialog, progress, skeleton, scroll-area, tooltip, alert, sonner, separator.
4. The app is wrapped in a `QueryClientProvider` and renders sonner's `<Toaster />`.

### 1. API layer (`src/api`)

1. `client.ts`: a fetch wrapper with the base URL from `VITE_API_URL`.
   Responses are parsed with the zod schemas from `@lomi/shared`.
   A non-2xx response throws an `ApiError` carrying `{ status, error, message }`.
2. One hook per endpoint, all TanStack Query: `useDocuments()`, `useDocument(id, versionNo?)`, `useProgress(id)`, `useUploadDocument()`, `useUploadVersion(id)`, `useReview()`, `useRetry(id)`.
3. Query keys live in one place: `['documents']`, `['document', id, versionNo]`, `['progress', id]`.
4. Polling: `refetchInterval: (q) => isInFlight(q.state.data) ? 2000 : false`, where in flight is `queued` or `extracting` (for the list, any row in flight).
5. Mutations invalidate `['documents']`, `['document', id]` and `['progress', id]` on success.
6. `useReview`: a `409 stale_version` shows the toast "A newer version arrived", then invalidates.

### 2. Document list (`/`)

1. A table with title, type, version, status and progress.
2. Status is a Badge: queued (secondary), extracting (with a spinner), extracted (green), failed (destructive, a Tooltip shows the error).
3. Progress: a Progress bar and "3 pending · 8 done".
4. Sort: failed first, then any with pending values, then the rest.
5. "Upload document" opens a Dialog with a type Select and a file input, sent with `useUploadDocument`.
   The new row shows up at once as queued.

### 3. Document detail (`/documents/:id`)

1. Header Card: title, type, a version Select (the current version by default), status Badge.
2. A summary line that answers "what needs me?", for example "2 changed since v1 · 1 gap · 9 carried over".
3. A failed version shows a destructive Alert with the error and a Retry button.
4. "Upload new version" opens a Dialog, sent with `useUploadVersion`.
5. Body in two columns.
   Left: value cards in API order (pending first).
   Right: a ScrollArea with the version's parsed text; the selected value's evidence is wrapped in `<mark>` using `evidenceStart`/`evidenceEnd` and scrolled into view.
6. Value card: field name, effective value, the evidence quote in a muted blockquote.
   - Status Badge: pending (amber), approved (green), corrected (purple, the model's value struck through), carried over (outline, "from v1").
   - A gap shows "No value" and its reason in plain words, always visible.
   - A value that changed after re-extraction shows a bordered "Previous (v1)" block with the old value and its review (action, corrected value, note).
   - Actions: Approve; Correct opens an inline form (value Input, required; note Textarea, optional; a Label on each).
     The buttons are disabled while the mutation is pending.
7. An older version is read-only: no actions, and an Alert banner "Viewing v1 (read-only)".

### 4. Loading and errors

1. Skeleton rows and cards while loading; never a blank page.
2. Upload errors show the API's message inline in the Dialog.

### 5. API additions this UI needs

1. `GET /documents` adds, per document, the current version's `error` and its review counts (`total` and `pending`, as in `GET /documents/:id/progress`), in one query.
2. `GET /documents/:id` and `GET /documents/:id/versions/:n` add `parsedText` to `version`.
3. `packages/shared` (recreated) holds the zod schemas of these responses and the review input; the API validates reviews with the shared `ReviewInputSchema`.
4. nginx proxies `/api/*` to the api with the prefix stripped, and accepts bodies up to the api's 11 MB upload cap; `VITE_API_URL` defaults to `/api`, and the Vite dev server proxies `/api` the same way.

## Out of scope

- Authentication and reviewer identity.
- A diff view between versions beyond the "Previous" block.
- Pagination of the document list.
- Dark mode beyond what the shadcn theme gives for free.

## Design notes

- `/documents/:id` is both a page and an api route, so same-origin api calls need a prefix; `/api` keeps the bundle free of a host and the browser free of CORS.
- "Changed since vN": the value has a `previous` and either the model's value differs from it (whitespace-normalised, as carry-over compares) or the value is `pending` while the previous value had a review (carry-over refused it because the evidence moved).
  A `pending` value with an unreviewed, identical previous value is plain pending, not changed.
- The summary counts: changed, other pending (excluding gaps), gaps (pending with no value), carried over; zero counts are left out, and nothing pending reads "Nothing needs review".
- Versions are numbered without gaps, so the version Select lists 1 to `currentVersion.versionNo`.
- The health page goes away; `/health` stays on the api.
- A correction carried over from an earlier version still strikes through the model's value: what counts is the latest review's action, not `reviewStatus`.
- After a saved review the value moves down the list, so the selection (and the marked evidence) moves to the value now on top, which is the next one to review.
- The evidence scroll moves only the text panel's own viewport, so the page stays on the card that was clicked.
- Queries are not retried on a 4xx: an unknown document shows "Not found" at once instead of after three backed-off retries.

## Acceptance criteria

- [x] Component (`apps/web/src/pages/DocumentPage.test.tsx`, vitest, Testing Library, MSW): pending values render before carried-over ones; a gap shows "No value" and its reason; the summary reads "2 changed since v1 · 1 gap · 2 carried over".
- [x] Component: Correct with an empty value is blocked (inline error, no request); Approve sends `{ action: "approve" }` and the Badge turns "Approved".
- [x] Component: polling (fake timers) refetches while the version is extracting and stops once it is `extracted`.
- [x] Component: the "Previous (v1)" block renders for both changed values with the old value and its review, and not for carried-over values or a gap; a carried-over correction strikes through the model's value.
- [x] Component: a `409 stale_version` on review shows the toast "A newer version arrived" and refetches.
- [x] Component: selecting a value marks its evidence in the text (also a regression test for the effect-cleanup crash, below); an older version is read-only with the "Viewing v1 (read-only)" banner.
- [x] Unit (`apps/web/src/lib/review.test.ts`): what counts as changed, the summary line, the triage sort.
- [x] Route (`apps/api/src/app.test.ts`) and integration against Postgres (`apps/api/src/review.test.ts`): `GET /documents` carries `error`, `total` and `pending`, newest first; the document views carry `parsedText` on `version` only; list, view and progress responses parse with the `@lomi/shared` schemas.
- [x] E2E in docker (api and web images rebuilt, nginx proxying `/api`): `doc-invoice-001` v2 shows "2 changed since v1 · 3 carried over", `due_date` and `total_amount` at the top with their v1 value and review, and the other 3 "Carried over from v1" (the vendor correction struck through); v1 is read-only.
  On a non-fixture lease: approve and correct (empty blocked, then saved with a note) updated badges, order and progress, and the selection moved to the next pending value.
  Upload: a non-PDF showed the API's message inline; a broken PDF appeared at once as queued, then failed (first in the list, error in the tooltip); Retry re-queued it and it failed again; a new version uploaded twice showed "This file is identical to the current version."; an unknown id shows "Not found".
  Found and fixed during E2E: clicking a card blanked the page (Chrome's `scrollIntoView` returns a Promise, which React called as the effect's cleanup; the jsdom stub now returns one too), the uppercased "PREVIOUS (V1)", a carried correction without the strikethrough, evidence left at the panel's edge, "Extracting" shown while queued, lowercase API messages, a 7-second skeleton before "Not found", and a cramped header on phones.

## Open questions

None.
Answered 2026-11-27: recreate `@lomi/shared` with the response schemas and the review input; extend the API (list counts and error, `parsedText`) rather than fetching progress per row; drop the health page.
