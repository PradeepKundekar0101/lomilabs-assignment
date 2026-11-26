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
| 002 | [PDF object storage and upload](002-pdf-object-storage.md) | Done |
| 003 | [Extraction worker](003-extraction-worker.md) | Draft |
| 004 | [Review API](004-review-api.md) | Draft |
| 005 | [New versions and carry-over](005-new-versions-and-carry-over.md) | Draft |

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
