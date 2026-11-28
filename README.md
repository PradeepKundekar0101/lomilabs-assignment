# Lomi document review

PDFs go in, an LLM extracts field values with the exact quote each one came from, and a reviewer approves or corrects every value.
When a revised PDF arrives, reviews of values whose evidence did not change carry over, and only what changed goes back to the reviewer.

## Run it

```bash
cp .env.example .env    # then set ANTHROPIC_API_KEY
docker compose up
```

The first build takes several minutes (it installs the npm packages inside Docker).
Compose starts Postgres, Redis, MinIO, the api, the worker and the web app, runs the migrations, and seeds version 1 of the three fixture documents, which the worker extracts within a few seconds each.
Without an API key everything still runs, and every extraction ends `failed` with a readable error and a Retry button.
If you add the key afterwards, run `docker compose up -d worker` (a restart does not re-read `.env`) and click Retry.
If port 5432 is taken on your machine, set `POSTGRES_PORT` in `.env`.

| What | Where |
|---|---|
| Review UI | http://localhost:8080 |
| API | http://localhost:3000 (`GET /health` shows version and queue counts) |
| MinIO console | http://localhost:9001 (`lomi` / `lomisecret`) |

What to click first:

1. Open **Invoice - Meridian Office Supplies**. Each value sits beside its quote, and selecting a value marks the quote in the document text.
2. Review every value: approve four and correct one (a correction needs a value; the note is optional).
3. Click **Upload new version** and pick `fixtures/documents/invoice-001.v2.pdf`.
   The page follows the extraction without a refresh and then reads "2 changed since v1 · 3 carried over": the due date and the total are pending with their v1 value and review beside them, and everything else is carried over.
4. Switch the version picker to v1: the old version and its reviews are still there, read-only.
5. **Market report** shows a gap: no value, with the model's reason.

Tests and checks run through turbo:

```bash
pnpm install
pnpm build    # a second run is fully cached
TEST_DATABASE_URL=postgres://lomi:lomi@127.0.0.1:5432/lomi_test TEST_REDIS_URL=redis://127.0.0.1:6379/1 pnpm turbo run typecheck lint test
./scripts/chaos.sh    # kills the worker and flushes Redis mid-extraction against the running stack
```

The integration tests need the compose Postgres and Redis; without the two variables they are skipped.
They use their own database and Redis database, because the compose worker would otherwise pick up their rows.

## Monorepo layout

pnpm workspaces and Turborepo.

| Package | What it holds |
|---|---|
| `apps/api` | Express API: uploads, reads, reviews, retry, health. Also the fixture seed. |
| `apps/worker` | BullMQ worker: claims a version, parses the PDF, calls the model, validates evidence, carries reviews over, commits. Also the reconciler. |
| `apps/web` | Vite + React review UI (TanStack Query, shadcn/ui), served by nginx, which proxies `/api` to the api. |
| `packages/core` | Pure extraction logic: PDF text, prompt, model client, output parsing, evidence validation, carry-over. No database or queue. |
| `packages/db` | Prisma schema, migrations and the client. |
| `packages/shared` | Zod schemas of the API's responses and of the review input, used by the api and parsed by the web app at runtime. |
| `spec/` | One spec per feature, written before the code; `spec/HANDOFF.md` has the gotchas. |

Why this split:

- The api and the worker deploy and scale separately: uploads must stay instant, while extraction is slow and limited by the model's rate limits.
- Everything that decides correctness (is this quote really in the text, did this field change) lives in `packages/core` as plain functions, so it is unit-tested without Postgres, Redis or a model.
- The API contract is written once in `packages/shared`; the UI validates every response against it instead of trusting a type cast.
- The pipeline is real: `generate` (Prisma client) runs before `build`, `typecheck` and `test`; each package builds after its dependencies; `migrate-test` migrates the test database before the integration tests; `lint` runs oxlint everywhere.

## Schema

```
documents 1──* document_versions 1──* extraction_runs
                                 1──* extracted_values 1──* reviews

documents.current_version_id         → the version under review
extracted_values.previous_value_id   → the same field in the version it was compared with
reviews.carried_from_review_id       → the review a carried-over review was copied from
```

- **documents**: the thing a client sends revisions of, with a pointer to its current version.
- **document_versions**: one row per uploaded PDF, numbered 1, 2, 3 per document.
  It holds the object's key and sha256, the parsed text, and the extraction state: `status` (`queued`, `extracting`, `extracted`, `failed`, `superseded`), `attempts`, `lease_until`, `error`.
- **extraction_runs**: one row per attempt, with the prompt, the raw model response, the outcome, the error and the token counts.
- **extracted_values**: one row per field per version, unique on `(version_id, field_key)`.
  `value` is the model's output and is never changed; `evidence` is the exact slice of that version's `parsed_text`, with its offsets; a gap has `value` null and a `gap_reason`.
  `previous_value_id` links the value to the same field in the version it was compared with.
  `review_status` (`pending`, `approved`, `corrected`, `carried_over`) is a cache of the latest review, so lists and counts need no join.
- **reviews**: append-only, `approve` or `correct` (with `corrected_value`) plus an optional note.
  A carried-over review is a new row on the new value, pointing at the review it came from.

Why it is shaped this way:

- Values belong to a version, so a new version never touches the old one: v1, its values and its reviews stay as they were and stay queryable.
- Lineage is explicit (`previous_value_id`, `carried_from_review_id`), so "what was this field in v1, and who approved it" is a join, not a guess.
- The unique key on `(version_id, field_key)` makes a duplicate extraction impossible, not just unlikely.
- Each version keeps its own parsed text, so evidence validation and the review UI for version N always work against version N's text, also after N+1 exists.

## Extraction: what lives in Redis and what lives in Postgres

Postgres is the source of truth for everything a user can see: versions and their status, attempts, errors, runs, values and reviews.
Redis (BullMQ) only delivers work: a job `{versionId}` with `jobId = versionId`, removed from Redis once it finishes.
Nothing in Redis is needed to rebuild the state, so losing Redis loses no data.

How one version is extracted:

1. **Upload.** The PDF is written to MinIO first, then the version row (`queued`) in a transaction, then the job is enqueued, and the api answers `202` (about 20-140 ms in my runs).
   If the enqueue fails, the upload still succeeds: the row is `queued` and the reconciler enqueues it.
2. **Claim.** One conditional `UPDATE` moves the version to `extracting` with a 60 s lease, only if it is `queued` or its lease has expired, and it has attempts left (3).
   Of any number of jobs for one version, only one claim succeeds; the others end as `not_claimable`.
3. **Heartbeat.** While the attempt runs, the lease is renewed every 20 s.
4. **Parse, then call the model.** The parsed text is saved first; the prompt and then the raw response are saved on the run before anything can fail on them.
5. **Validate the evidence**, then carry reviews over and **commit** in one transaction under the document's row lock, with `ON CONFLICT DO NOTHING` on the values.
6. **Fail as a state.** A parse or model error sets the version `failed` with a readable error (for example `llm_request_failed: 401 authentication_error: invalid x-api-key`); the user retries it from the UI.

The **reconciler** in the worker runs every 15 s and enqueues every version Postgres says needs work: `queued`, or `extracting` with an expired lease.
That one loop is what makes Redis disposable.

What happens when something fails (each of these was run against the compose stack):

| Failure | What happens | Observed |
|---|---|---|
| Worker killed mid-extraction | The lease stops moving and expires; the reconciler re-enqueues; the next claim is attempt 2. | Extracted 94 s after `docker compose kill worker` (60 s lease, up to 15 s reconcile, then a 25 s model call). |
| `docker compose restart` | The worker gets SIGTERM and lets its running job finish; one that outlives Docker's 10 s grace is killed and resumes as above. The seed re-runs and adds nothing. | Finished during shutdown; with `restart -t 0` (immediate kill) extracted 67 s later. |
| `redis-cli FLUSHALL` + restart | A job in flight keeps running and commits to Postgres; queued jobs are gone from Redis and come back through the reconciler. | 1 extracting + 3 queued versions, flushed and hard-restarted: all 4 extracted within 66 s; every earlier value and review intact. |
| Redis down | Uploads still succeed (the producer fails fast, the row stays `queued`); `/health` answers 503; jobs flow again when Redis is back. | Upload answered `202` in 0.12 s with Redis stopped, and was extracted 13 s after Redis came back. |
| Postgres down | The api answers 500 (`/health` 503); the worker cannot claim or commit, so nothing is half-written; leases expire and the reconciler resumes the versions when Postgres is back. | Stopped mid-extraction for 15 s: the version resumed on attempt 2 and was extracted 49 s after Postgres came back. |
| The same version enqueued twice, Retry clicked twice | `jobId` dedupes waiting jobs; the claim lets one through; the unique key catches the rest; Retry is one guarded `UPDATE` (the second click gets `409`). | 4 extra jobs for one version: 1 run, 5 values. Two concurrent retries: one `202`, one `409`. |
| A PDF that crashes the worker every time | Only attempts that never finish count towards the cap; after 3 the version is `failed` with `too_many_attempts`. | Integration test. |

No version stays `extracting` forever: either a live worker renews its lease, or the lease expires and the version is claimed again, until the attempt cap fails it visibly.
A killed attempt's run row keeps `outcome` null, since it never finished and nothing rewrites history.

## Decisions the brief left open

**Correction model: a correction lives beside the value.**
`extracted_values.value` is always what the model said, and the evidence belongs to it; a correction is a `reviews` row with `corrected_value` and an optional note.
The effective value is the latest correction, or the model's value.
The API takes `{"action": "approve"}` or `{"action": "correct", "correctedValue": "...", "note": "..."}`, and the UI shows the model's value struck through next to the correction.
This keeps provenance (the quote still matches the value it is shown with), keeps the review history, and lets carry-over compare the model's reading of v1 with its reading of v2.

**A new version while the previous one is still extracting: supersede.**
The upload always becomes current at once.
When the worker reaches the older version's currency check (before the model call, and again at commit under the document lock), it marks it `superseded` and writes no values.
A previous version that already finished stays `extracted` and is the base for carry-over.
The reviewer wants the newest file reviewed; rejecting would make them wait for an extraction nobody will review, and queueing both would spend a model call on it.
Uploading bytes identical to the current version is refused with `409`.

**Polling, every 2 s, only while something on screen is queued or extracting.**
An extraction takes seconds and passes through three states, and a reviewer works on one document at a time; polling needs no extra infrastructure and stops on its own (the network tab goes quiet once nothing is in flight).
Queries also refetch when the window regains focus, which is when a document uploaded by someone else shows up on the list.
With many reviewers or long-running work I would push changes instead (server-sent events from Postgres `LISTEN/NOTIFY`).

**What "unchanged" means.**
For each field, the new value is compared with the same field in the latest earlier extracted version.
It is unchanged when the model's value is the same (whitespace-normalised) and its evidence is either the same quote or the old quote still appears in the new version's text.
A field that was a gap and is still a gap is unchanged too.
Checking that the old quote is still present, instead of comparing offsets or whole pages, holds when the text around it shifts, wraps or gains lines, and when the model quotes a slightly different span of the same passage.
An unchanged value gets the old latest review copied forward and is `carried_over`; anything else is `pending` and shows the previous value and its review.
With the fixture's v2 exactly the two edited fields (due date and total) come back as pending.

**PDFs in MinIO, parsed text in Postgres.**
The bytes go to S3-compatible storage under `pdfs/<sha256>.pdf`, written before the database row so a row never points at a missing object; Postgres keeps the key, the hash and the parsed text.
That keeps the database small and is the same code against S3 or GCS in production.
The parsed text is stored per version rather than re-parsed, so the evidence offsets and the highlighting always point into the exact text that was validated.

**Evidence validation, the hallucination defense.**
Each quote must appear in the version's parsed text, ignoring whitespace differences only (PDF text extraction and the model rarely agree on line breaks); the stored evidence is then the exact slice of the parsed text.
A quote that is not there becomes a gap with reason `evidence_not_found`, a field the model did not return becomes `missing_from_llm_output`, and a field the model could not find keeps its own reason.
`packages/core/src/evidence.test.ts` covers the hallucinated quote.

**The model.** `claude-opus-5-5` with structured output against a zod schema, effort `medium`, and server-side refusal fallback.
An extraction uses about 1,100 input and 260 output tokens, roughly one cent.

## Tests

Tests sit where breakage would be silent or expensive: 104 tests across the packages.

- `packages/core`: evidence validation (including a hallucinated quote), carry-over rules, model output parsing, model error messages, PDF text.
- `apps/worker` against real Postgres and Redis: racing claims, a worker killed mid-extraction, a Redis flush, the attempt cap, retry.
- `apps/api` against real Postgres and Redis: uploads and their failure modes, reviews and the stale-version `409`, carry-over end to end through the worker, retry, the seed.
- `apps/web` with MSW: polling starts and stops, approve and correct, the stale-version message, what counts as changed, the list order.

## What I cut, and what is next

Cut, on purpose:

- Authentication and reviewer identity: reviews have no author yet.
- Pagination of the document list.
- OCR: a scanned PDF without a text layer fails with `no_text_layer`.
- Normalising dates and amounts before comparing versions (`$5,230.29` and `5230.29` count as a change).
- Cleanup of objects orphaned by a failed upload transaction.
- Backoff between crash attempts, and metrics beyond `/health`.
- CI and a deployment: everything is verified locally.

Next, in order: reviewer identity on reviews, CI running the turbo pipeline against service containers, a deployment (Cloud Run or ECS, managed Postgres and Redis, S3 or GCS), then the scale work below.

## At 10,000 documents

- **List**: paginate with a cursor on `(created_at, id)` and filter by status; keep pending and total counts on the version, updated at commit and review, instead of aggregating values on every request.
- **Throughput**: run more workers (the claim is safe across them) and rate-limit them to the model's limits with BullMQ's limiter and backoff on 429; use the Batches API for bulk backfills, which is half the price and needs no latency.
- **Cost**: about $100 per 10,000 extractions at today's token counts; log cost per run and alert on outliers.
- **Updates**: polling a paginated list is still fine; with many reviewers move to server-sent events.
- **Reconciler**: it already uses the `(status, lease_until)` index; enqueue in batches and let one worker run it (a Postgres advisory lock).
- **Storage**: parsed text stays in Postgres (a few KB each); PDFs stay in object storage with a lifecycle policy for superseded versions.
- **Review load**: a queue of pending values across documents (changed values first), so several reviewers can work through fields without opening every document.
