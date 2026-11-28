# 009 API layers and validated boundaries

Status: Done (2026-11-28, branch `api-layers`; requested by the user: controllers, routes, services, types in their own folder, zod validation)
Depends on: 002, 004, 005, 007

## Goal

The api is split into routes, controllers and services, with its types in their own folder.
Every input that crosses a trust boundary is parsed with zod.
No endpoint changes its behavior.

## Requirements

1. **Layout of `apps/api/src`.**
   - `routes/`: one Express `Router` per resource (`health`, `documents`, `values`), mounted by `app.ts`. Routes only map paths and middleware to controller handlers.
   - `controllers/`: one factory per resource that takes the app's dependencies and returns its handlers. A controller validates the request, calls services and maps their results to HTTP responses.
   - `services/`: the business logic and data access (document reads, version creation, review, retry, health counts, seed). Services know nothing about HTTP.
   - `schemas/`: the zod schemas for route params, the multipart upload form, the seed manifest and the environment, plus the `validate` helper.
   - `middleware/`: the multipart parser and the error handler.
   - `types/`: every interface and type the api declares (dependencies, service results, inferred schema types).
   - `errors.ts`: `HttpError` and the services' domain errors. `infra.ts`: the database, object storage and queue clients.
   - `main.ts` and `seed.ts` stay the entry points (`dist/main.js`, `dist/seed.js`).
2. **Errors.** A controller throws `HttpError(status, message, details?)`; the error handler sends `{ error: message, ...details }`.
   Services throw domain errors (`StorageUnavailableError`, `VersionRejectedError`) that the controller maps.
3. **Zod at every boundary.**
   - Route params: a document id is a non-empty string, a version number is 1 to 9 digits, a value id is a uuid. A param that fails is a 404, as before.
   - The upload form: `type` is a document type, `file` is a PDF of at most 10 MB. A failure is a 400 with the first issue's message, as before.
   - The review body: `ReviewInputSchema` from `@lomi/shared`, as before.
   - The environment: the api, the seed and the worker parse `process.env` with a schema at startup and exit with every missing or invalid variable listed.
   - The seed manifest (`fixtures/documents.json`) is parsed with a schema before seeding.
   - The worker parses each job's data: a job whose `versionId` is not a uuid is logged and skipped, instead of failing in Postgres's uuid cast.
4. **Worker.** The worker's interfaces and types move to `apps/worker/src/types/`, its env and job schemas to `apps/worker/src/schemas/`. It has no routes or controllers.
5. **A body-size fix.** Only the multipart upload maps an oversized body to `400 file must be at most 10 MB`. An oversized JSON review body gets body-parser's `413`, not a message about files.

## Out of scope

- Any change to response shapes, status codes or messages, other than requirement 5.
- `packages/*` and `apps/web`.
- A JSON 404 for unknown routes, pagination, auth.

## Design notes

- Dependencies stay plain functions and objects passed in (`createApp(deps)`, `createVersion(deps, ...)`), as before; no classes or container.
- Controllers validate inside the handler, not in a generic middleware, so each route keeps its own error status and message and the parsed values stay typed.
- `validate` uses `safeParseAsync`, because the PDF check reads the file's first bytes.

## Acceptance criteria

- [x] `pnpm turbo run build typecheck lint test` passes, with the Postgres and Redis tests running (api 51, worker 15, core 33, web 11; lint 0 warnings).
- [x] The existing api tests pass with only their import paths changed. The upload test now also asserts each 400's exact message, which the old code produced too.
- [x] New tests: an oversized JSON review body gets `413`; the env schema reports missing variables; the worker skips a job with a non-uuid `versionId`; a non-uuid value id is a 404; a malformed multipart body is a 400.
- [ ] End to end against `docker compose` with rebuilt api and worker images: `migrate-seed` seeds, an upload is extracted, a review and a retry work through the web app's `/api` proxy.
  Skipped at the user's request on 2026-11-28: the images built, but the build filled the host disk and Docker had to be restarted (gotcha 11). Run it before relying on the running stack.

## Open questions

None.
