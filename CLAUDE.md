# lomilabs-assignment

Start every session by reading `spec/HANDOFF.md` (current state, gotchas, how to run) and `spec/README.md` (spec-driven workflow).

- Build only from specs in `spec/`. A `Draft` spec needs the user's answers to its open questions before implementation.
- When work changes the state of the project, update the spec's status and the tables in `spec/README.md` and `spec/HANDOFF.md`.
- Run compose with `POSTGRES_PORT=5433` on this machine.
- Verify with `pnpm turbo run build typecheck lint test` and an end-to-end check against `docker compose`.
