# 007 Extraction resilience

Status: Done (verified 2026-11-27, in review on branch `extraction-resilience`; design given by the user)
Depends on: 003

## Goal

Extraction survives worker crashes, restarts and a Redis `FLUSHALL`.
Postgres is the source of truth; Redis only delivers jobs.

## Requirements

1. **Lease and heartbeat** (worker).
   - `LEASE_SECONDS` (env, default 60). The claim sets `lease_until = now() + lease`.
   - While a claimed job runs, every lease/3 (20 s at the default) the worker runs
     `UPDATE document_versions SET lease_until = now() + lease WHERE id = $1 AND status = 'extracting'`.
     The heartbeat stops in a `finally` block.
   - A killed worker's version is therefore recoverable about one lease after its last heartbeat.
2. **Reconciler** (`apps/worker/src/reconciler.ts`).
   - Runs once at worker startup, then every `RECONCILE_SECONDS` (env, default 15), one run at a time.
   - Selects versions `WHERE status = 'queued' OR (status = 'extracting' AND lease_until < now())` and enqueues `{versionId}` with `jobId = versionId` for each.
   - Safe with several workers: BullMQ ignores a duplicate `jobId`, and the claim decides who runs.
   - Logs how many it enqueued, only when more than 0.
3. **BullMQ job options**, for every producer (api upload, api retry, reconciler): `removeOnComplete: true`, `removeOnFail: true`, `attempts: 1`.
   BullMQ silently ignores adding a `jobId` it still holds, so a kept finished job would block every retry and reconcile of that version.
   Stalled-job detection stays on as the fast path; the reconciler is the guarantee.
4. **Attempt cap.** `MAX_ATTEMPTS = 3`.
   A claimable version that already used 3 attempts is set `failed` with error `too_many_attempts: ...` instead of being claimed.
   A PDF that crashes the worker therefore stops after 3 attempts instead of looping.
5. **Retry endpoint** (api). `POST /documents/:id/retry`.
   - 404 for an unknown document; 409 unless the current version's status is `failed`.
   - One statement (so one transaction) sets the current version `queued`, `error` null, `attempts` 0, `lease_until` null, guarded by `status = 'failed'`.
   - Then enqueues it (`jobId = versionId`) and returns `202` with `{id, versionId, status: "queued"}`.
   - If the enqueue fails it still returns `202`; the reconciler picks the version up.
6. **Graceful shutdown** (worker). On `SIGTERM` or `SIGINT`: stop the reconciler, `worker.close()` (lets running jobs finish), then close the queue, Redis and Postgres connections.
   An interrupted job is never marked failed; its lease expires and the reconciler resumes it.
7. **Health.** `GET /health` also reports queue counts (`waiting`, `active`) and the number of versions per status.
   The Postgres check is the per-status count query and the Redis check is the queue count query, so each count doubles as its service check.
   A service that is down reports `"error"` and `null` counts; the status code stays 200 only when both are up.
   The web health page shows the counts.
8. **Chaos script** `scripts/chaos.sh`: uploads fixtures, `docker compose kill worker` mid-extraction then starts it, then `redis-cli FLUSHALL` mid-extraction and restarts the worker, then waits and prints each document's final status and value count from `psql`.

## Design notes

- **What a crash leaves behind.** A dead worker's version stays `extracting` with a lease that stops moving, and its BullMQ job stays active until BullMQ's stalled check (lock 30 s) moves it back to waiting.
  If that job runs before the lease expires, the claim refuses it (`not_claimable`) and the job is removed; the reconciler enqueues the version again once the lease has expired.
  Either way the version is claimed again within about lease + reconcile interval.
- **FLUSHALL with a live worker.** A job in flight keeps running and commits to Postgres; only its BullMQ bookkeeping fails, which the worker logs.
  Versions that were `queued` lose their jobs and come back through the reconciler.
- **Duplicate jobs.** `jobId = versionId` collapses duplicates while a job is waiting or active; the claim (one conditional `UPDATE`) and `ON CONFLICT DO NOTHING` on values cover everything else.
- **Attempts count claims, not failures.** A normal failure (LLM error, no text) ends `failed` on its first attempt and is retried only by the user.
  Only attempts that never finished (crash, kill, lost lease) can reach the cap.
- **Retry resets `attempts` to 0**, so the next run's `attempt` number starts at 1 again; `extraction_runs` keeps every earlier row, ordered by `started_at`.
- A killed attempt's run row keeps `outcome` null and `finished_at` null: it never finished, and nothing rewrites history.
- The heartbeat and reconciler timers are `unref`'d: the Redis and Postgres connections keep the worker alive, not a timer.
- **Test isolation.** The compose worker's reconciler scans the whole database it is given, so tests must not share it.
  `TEST_DATABASE_URL` points at a dedicated database (`lomi_test` on the compose Postgres), which turbo migrates before tests (`@lomi/db#migrate-test`; `prisma migrate deploy` creates it if missing).
  `TEST_REDIS_URL` points at a separate Redis logical database (`redis://127.0.0.1:6379/1`), and each test file uses its own queue name.
  A "FLUSHALL" in the tests deletes every Redis key of the test's queue: the same loss as far as that queue can tell, without wiping the queues of test files running in parallel.
  Inside the test database, the resilience tests' reconciler only enqueues the versions those tests created, because other test files run in parallel against the same database.
- **Test timings keep the production ratio.** Production has a 60 s lease and BullMQ's 30 s lock, so a dead worker's job returns from the stalled check before the lease expires and the claim refuses it; only the reconciler resumes the version.
  The tests use a 1.5 s lease, a 0.5 s lock and a 0.2 s reconcile interval, so they fail if the reconciler stops working.
  Each mechanism was checked by breaking it: no heartbeat, a reconciler that enqueues nothing, and no attempt cap each make their test fail, and so does keeping completed jobs in the api's queue.
- **Killing a worker in-process.** A test "kill" force-closes that worker's BullMQ `Worker` (no lock renewal), makes its Postgres client hang on every later call (no heartbeat, no writes) and never resolves its model call, which is what a `SIGKILL` looks like from Postgres and Redis.

## Out of scope

- Marking a killed attempt's run row as abandoned.
- Backoff between crash attempts.
- Metrics or alerting beyond `/health`.

## Acceptance criteria

Integration tests against real Postgres and Redis with a fake, slow model (`apps/worker/tests/resilience.test.ts`, `apps/api/tests/retry.test.ts`):

- [x] Worker killed mid-extraction: after lease expiry and a reconcile, the version ends `extracted` with `attempts` 2.
- [x] An attempt that outlives its lease, with its job flushed from Redis, keeps its claim through the heartbeat: one attempt.
- [x] Redis flushed mid-extraction: the version ends `extracted`; an already extracted version's values and reviews and the run history are unchanged.
- [x] Redis flushed with versions `queued`: all of them end `extracted`.
- [x] The same version enqueued 3 times in parallel: one run, no duplicate values.
- [x] A PDF that always crashes the worker: `failed` with `too_many_attempts` after 3 attempts.
- [x] Retry on a failed version: `202`, the version is `queued` with `attempts` 0, and its job is waiting in Redis even though an earlier job with the same id completed; the worker then extracts it.
- [x] Retry on an extracted version: `409`; unknown document: `404`; enqueue failure: still `202`.
- [x] `/health` reports per-status counts and queue counts, and `null` counts for a service that is down (unit).
- [x] E2E: `scripts/chaos.sh` against `docker compose` (real model) settled 68 s after the last worker restart: all 9 documents `extracted`, the 2 whose worker was killed mid-extraction with `attempts` 2.
- [x] E2E: with MinIO stopped (`docker stop`, so compose does not restart it as a dependency) a lease upload ended `failed` with `unexpected_error: getaddrinfo ENOTFOUND minio`; after MinIO was back, `POST /documents/:id/retry` returned `202`, a second retry `409`, and the version ended `extracted` with 5 values and both runs kept.
- [x] E2E: with Redis stopped, `/health` answered `503` in 0.04 s with `queue: null`, and `200` once Redis was back; the web health page shows the counts (checked in light and dark, at phone width).

Tests run with `TEST_DATABASE_URL=postgres://lomi:lomi@127.0.0.1:5433/lomi_test TEST_REDIS_URL=redis://127.0.0.1:6379/1 pnpm turbo run test`; the full suite passed 5 runs in a row, partly under a concurrent docker build.

## Open questions

None.
