# 012 Light backdrop and page headers

Status: Done (verified 2026-11-28; in PR #15, not merged yet)
Approved: 2026-11-28, the user asked for light images from the Super Visuals backgrounds library and layout improvements, and left the calls to Claude.
Depends on: 008, 011

## Goal

The review UI gets one light background image behind the top of every page, and both pages share one page-header layout that sits on it.
The document list says what needs review instead of explaining its sort order alone.

## Requirements

### 1. Backdrop

1. The image is BG 005 "Pastel Cloud Glow" from the Figma Community file "Super Visuals: Backgrounds Library." (node `64898:6`), a 1536x1024 pastel sky.
2. It ships as `apps/web/src/assets/pastel-cloud-glow.webp` (WebP, quality 90, about 17 KB), imported so Vite hashes it and nginx serves it from `/assets/` as immutable.
3. The app shell draws it full-bleed behind the header and the page header, `cover`, and fades it out with a mask into the page wash, so content cards below sit on the plain wash.
4. It is decorative: `aria-hidden`, no pointer events, no motion.
5. The header bar is transparent over the image (no white bar).

### 2. Page headers

1. Both pages lay out their header the same way, directly on the backdrop, without a Card: the title on the left, the actions on the right (stacked under the title on phones), then the summary lines.
2. Document list:
   - Title "Documents" and the "Upload document" button, as before.
   - A summary line from the documents, for example "34 values to review in 12 documents · 2 failed · 1 in progress"; "Nothing to review" when no value is pending; "No documents yet" when the list is empty; a skeleton while loading.
   - The sort explanation stays, as a quieter second line.
   - On phones the table cells have tighter padding, so a title like "invoice-001.pdf" stays on one line (it broke over two or three before).
3. Document page (revises spec 008 requirement 1, the header Card):
   - The back link, then the title, the type, version Select and status Badge, and the "Upload new version" and "Delete" buttons, without a Card.
   - The review summary and the progress line under them, or the queued or extracting message.
   - The read-only and extraction-failed Alerts move under the header, above the values.
   - The loading skeleton follows the new header shape.

## Out of scope

- A dark mode, and more than one image.
- Filters, search, or new columns on the list.
- Changing the shadcn components in `src/components/ui`.

## Design notes

- Text on the backdrop keeps WCAG AA. The design system's muted grey (#6b6b74) measured 3.45:1 on the image's lavender, so the `on-sky` utility in `index.css` sets `--muted-foreground` to #55555e on elements drawn on the backdrop (the app header, both page headers, the back link); text inside cards keeps #6b6b74.
- The Figma MCP could not open the community file (it needs edit access), so the original PNG was saved from the file's public view; exporting node `64898:6` from a duplicated copy gives the same image.
- Figma Community files are shared for reuse under the Figma Community terms; the source is recorded here and next to the import.

## Acceptance criteria

- [x] `listSummary` counts pending values, documents with pending values, failed and in-flight documents, and words the empty and nothing-pending cases (unit test, `apps/web/tests/review.test.ts`).
- [x] The existing list, document page and delete component tests pass with the new headers (16 web tests).
- [x] `pnpm turbo run build typecheck lint test` passes (24 tasks, with the Postgres and Redis tests).
- [x] E2E in docker through nginx (web image rebuilt and recreated): the image is served as `/assets/pastel-cloud-glow-<hash>.webp`, 17 KB, `Cache-Control: public, max-age=31536000, immutable`; the list (1440 and 375 px, no horizontal scroll) and the document page's read-only v1 view (1440 px) render on the backdrop with the Alert under the header. Against the Vite dev server: the document page at 1440, 768 and 375 px and the not-found page at 1440 px. Every text element on the backdrop was measured against the image pixels under it (mask included) at 4.82:1 or more.

## Open questions

None; the user delegated the calls.
