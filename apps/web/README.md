# @lomi/web

The review UI (spec 008): a document list at `/` and a document's values, evidence and reviews at `/documents/:id`.
Vite, React, TanStack Query, React Router, Tailwind CSS v4 and shadcn/ui (in `src/components/ui`, generated; edit theme tokens only).

## Run

```bash
pnpm --filter @lomi/web dev
```

The dev server proxies `/api/*` to the api at `API_URL` (default `http://localhost:3000`) with the prefix stripped, as nginx does in Docker.
`VITE_API_URL` overrides the `/api` base the browser calls.

## Layout

- `src/api`: `client.ts` (fetch, parsed with the `@lomi/shared` schemas, `ApiError`) and `hooks.ts` (one TanStack Query hook per endpoint, the query keys, polling).
- `src/lib/review.ts`: what counts as changed, the "what needs me?" summary, the list's triage order.
- `src/pages`, `src/components`: the two pages and their parts.
- `src/test`: MSW server, fixtures and a render helper for the component tests.
