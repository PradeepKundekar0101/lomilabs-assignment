# Specs

This project uses spec-driven development.
Every feature starts as a numbered spec in this folder, and code follows the spec, not the other way round.

## Workflow

1. **Draft.** Write or update `NNN-name.md` from the template below. List assumptions and open questions explicitly.
2. **Confirm.** The user answers the open questions and marks the spec `Approved`. Do not implement a `Draft` spec without that.
3. **Implement.** Build exactly what the spec says. If reality forces a change, update the spec first, then the code.
4. **Verify.** Every acceptance criterion gets a check: a unit test, or an end-to-end check against `docker compose`. Record how it was verified in the spec.
5. **Done.** Set status to `Done`, note the commit or PR, and update the table in `HANDOFF.md`.

## Index

| # | Spec | Status |
|---|------|--------|
| 001 | [Database schema](001-database-schema.md) | Done |
| 002 | [PDF object storage, upload and document reads](002-pdf-object-storage.md) | Done (revision 2 merged in [PR #2](https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/2)) |
| 003 | [Extraction worker (happy path)](003-extraction-worker.md) | Done (merged in [PR #2](https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/2)) |
| 004 | [Review API](004-review-api.md) | Done (revision 2, merged in [PR #5](https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/5)) |
| 005 | [New versions and carry-over](005-new-versions-and-carry-over.md) | Done (revision 2, merged in [PR #6](https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/6)) |
| 006 | [Seed the fixture documents](006-seed-fixtures.md) | Done (merged in [PR #2](https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/2)) |
| 007 | [Extraction resilience](007-extraction-resilience.md) | Done (merged in [PR #4](https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/4)) |
| 008 | [Review UI](008-review-ui.md) | Done (revision 2, merged in [PR #7](https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/7)) |
| 009 | [API layers and validated boundaries](009-api-layers-and-validation.md) | Done (merged in [PR #11](https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/11)) |
| 010 | [Cloud deployment](010-cloud-deployment.md) | Done (revision 2, Google Cloud; merged in [PR #12](https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/12)) |
| 011 | [Delete documents](011-delete-documents.md) | Done (merged in [PR #14](https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/14)) |
| 012 | [Light backdrop and page headers](012-light-backdrop-and-page-headers.md) | Done (merged in [PR #15](https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/15)) |
| 013 | [Extraction eval](013-extraction-eval.md) | Done (verified 2026-11-28; in [PR #16](https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/16), not merged yet) |
| 014 | [Evidence hardening and CI](014-evidence-hardening.md) | Approved |

## Template

```markdown
# NNN Title

Status: Draft | Approved | Done
Depends on: NNN

## Goal
One or two sentences on the outcome.

## Requirements
Numbered, testable statements.

## Out of scope

## Design notes

## Acceptance criteria
Checklist; each item says how it is verified.

## Open questions
```
