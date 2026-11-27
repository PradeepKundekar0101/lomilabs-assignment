# 001 Database schema

Status: Done (commit `04c60c1`, PR #1)
Depends on: none

## Goal

A Postgres schema for documents, their versions, extraction attempts, extracted values and human reviews, managed with Prisma migrations that run automatically on `docker compose up`.

## Requirements

1. Tables `documents`, `document_versions`, `extraction_runs`, `extracted_values`, `reviews`, with the columns in `packages/db/prisma/schema.prisma`.
2. `documents.type` is an enum: `invoice | lease | report`.
3. `document_versions.status` is an enum: `queued | extracting | extracted | failed | superseded`, default `queued`, with `attempts` (default 0), `lease_until` and `error`.
4. Unique `(document_id, version_no)` on `document_versions`.
5. `extraction_runs` is append-only, one row per attempt, `outcome` enum `succeeded | failed | superseded`.
6. Unique `(version_id, field_key)` on `extracted_values`, so a version cannot be extracted twice for the same field.
7. CHECK `extracted_values_value_or_gap_reason`: `value IS NULL OR gap_reason IS NULL`.
8. `extracted_values.previous_value_id` points at the same field in the prior version.
9. `reviews` is append-only (never updated or deleted); `action` enum `approve | correct`; `carried_from_review_id` set when a review is copied to a new version.
10. A correction never overwrites `extracted_values.value`; it lives in `reviews.corrected_value`.
11. Index on `document_versions(status, lease_until)` and on every foreign key.
12. The package exports the schema types and a db client.
13. A `migrate` script, and a one-shot `migrate` compose service that `api` and `worker` wait on (renamed `migrate-seed` by spec 006).

## Decisions taken during implementation

- Prisma 7.10.1 (the user switched from Drizzle). Table and column names are snake_case via `@@map` / `@map`.
- IDs default to `gen_random_uuid()` in the database, so raw SQL inserts work too.
  Spec 006 changed `documents.id` to `text` (still defaulting to a uuid) so seeded documents keep the fixture manifest's ids.
- `documents.current_version_id` is UNIQUE: Prisma needs that for a 1:1 relation, and a version is current for at most one document.
- `extraction_runs.outcome` is nullable while an attempt is still running.
- Foreign keys use Prisma defaults: `ON DELETE RESTRICT` for required relations, `SET NULL` for optional ones.
- The CHECK constraint is hand-written SQL appended to the generated migration, since Prisma cannot model it.
- Append-only for `reviews` and `extraction_runs` is a convention enforced in code, not by the database.
- `createDb(url)` returns a `PrismaClient` using `@prisma/adapter-pg`. The package also re-exports everything from the generated client (types, enums such as `DocumentType`).

## Acceptance criteria

- [x] `docker compose up` creates all tables (verified: `\dt` lists 5 tables plus `_prisma_migrations`).
- [x] `\d` shows the unique keys, FK indexes, `(status, lease_until)` index and the CHECK (verified in psql).
- [x] The CHECK rejects a row with both `value` and `gap_reason` set (verified with an insert).
- [x] `pnpm turbo run build typecheck lint test` passes from a clean `src/generated` and `dist`.

## Open questions

- Should append-only be enforced in the database (revoke UPDATE/DELETE, or a trigger)?
