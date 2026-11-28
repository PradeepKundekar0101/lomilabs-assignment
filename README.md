<div align="center">

# Lomi document review

**PDFs in, values out, and a human checks every one before it is trusted.**

An LLM extracts field values from each PDF together with the exact quote they came from.
A reviewer approves or corrects each value beside its quote.
When a revised PDF arrives, reviews of unchanged values carry over, and only what changed comes back for review.

![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-26-5FA04E?logo=nodedotjs&logoColor=white)
![Turborepo](https://img.shields.io/badge/Turborepo-pnpm_workspaces-EF4444?logo=turborepo&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-BullMQ-FF4438?logo=redis&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white)
![Claude](https://img.shields.io/badge/Claude-Opus_5.5-D97757?logo=anthropic&logoColor=white)

</div>

<p align="center">
  <img src="docs/review-v2.png" alt="The revised invoice: the summary reads 2 changed since v1 and 3 carried over; the changed due date shows its v1 value and approval under it, and the matching quote is highlighted in the document text." width="900">
  <br>
  <sub>The revised invoice: the two changed values are on top with their v1 value and review, the rest carried over, and the selected value's quote is marked in the text.</sub>
</p>

---

## Contents

- [Quick start](#quick-start)
- [A two-minute tour](#a-two-minute-tour)
- [Architecture](#architecture)
- [Monorepo layout](#monorepo-layout)
- [Data model](#data-model)
- [How extraction runs](#how-extraction-runs)
- [Decisions the brief left open](#decisions-the-brief-left-open)
- [Tests](#tests)
- [Deployment](#deployment)
- [What I cut, and what is next](#what-i-cut-and-what-is-next)
- [At 10,000 documents](#at-10000-documents)

---

## Quick start

```bash
cp .env.example .env    # then set ANTHROPIC_API_KEY
docker compose up
```

That one command starts Postgres, Redis, MinIO, the api, the worker and the web app.
It runs the migrations and seeds version 1 of the three fixture documents, which the worker extracts within a few seconds each.
The first build takes several minutes, because it installs the npm packages inside Docker.

| Service | URL | Notes |
|---|---|---|
| **Review UI** | http://localhost:8080 | Start here. |
| API | http://localhost:3000 | `GET /health` shows version and queue counts. |
| MinIO console | http://localhost:9001 | `lomi` / `lomisecret` |

> [!NOTE]
> Without an API key everything still runs, and every extraction ends `failed` with a readable error and a Retry button.
> If you add the key afterwards, run `docker compose up -d worker` (a restart does not re-read `.env`) and click **Retry**.

> [!TIP]
> If port 5432 is already taken on your machine, set `POSTGRES_PORT` in `.env`.

---

## A two-minute tour

1. **Open "Invoice - Meridian Office Supplies".**
   Each value sits beside its quote; selecting a value marks the quote in the document text.
2. **Review every value:** approve four and correct one.
   A correction needs a value; the note is optional.
3. **Click "Upload new version"** and pick `fixtures/documents/invoice-001.v2.pdf`.
   The page follows the extraction without a refresh, then reads **"2 changed since v1 · 3 carried over"**.
   The due date and the total are pending, each with its v1 value and review beside it.
4. **Switch the version picker to v1.**
   The old version and its reviews are still there, read-only.
5. **Open the market report** to see a gap: no value, and the model's reason why.

---

## Architecture

<p align="center">
  <img src="docs/architecture.png" alt="Architecture: the React web app calls the API server; the API writes PDFs to the S3 bucket, rows to Postgres and jobs to the Redis BullMQ queue; the worker takes jobs from Redis, calls the Anthropic LLM and writes to Postgres, the source of truth." width="900">
</p>

| Flow | What travels on it |
|---|---|
| Web app → API | Every call goes through nginx at `/api`, so the browser needs no CORS and no API host. On Vercel the bundle calls the API's Cloud Run URL, and the api allows that one origin ([Deployment](#deployment)). |
| API → S3 bucket | The PDF bytes, stored as `pdfs/<sha256>.pdf` (MinIO locally). |
| API → Postgres | The document and version rows, and every review. |
| API → Redis | One job per version to extract, `{versionId}`. |
| Worker ↔ Redis | The worker takes jobs, and its reconciler puts back any job Redis lost. |
| Worker → S3 bucket | The worker reads the PDF it is extracting. |
| Worker → Anthropic | One structured-output call per extraction. |
| Worker → Postgres | Status, leases, runs, values and carried-over reviews. |

---

## Monorepo layout

pnpm workspaces with a Turborepo pipeline.

```text
apps/
  api/        Express API: uploads, reads, reviews, retry, health; also the fixture seed
    src/      routes/ -> controllers/ -> services/, with schemas/ (zod), types/, middleware/
  worker/     BullMQ worker: claim, parse, call the model, validate, carry over, commit; also the reconciler
  web/        Vite + React review UI (TanStack Query, shadcn/ui), served by nginx
packages/
  core/       Pure extraction logic: PDF text, prompt, model client, evidence validation, carry-over
  db/         Prisma schema, migrations and client
  shared/     Zod schemas of the API's responses and of the review input
spec/         One spec per feature, written before the code; HANDOFF.md has the gotchas
fixtures/     The sample PDFs, the manifest and the expected fields
infra/        Terraform for Google Cloud: Cloud Run, Cloud SQL, Memorystore, Cloud Storage, Secret Manager
scripts/      chaos.sh, and build-images.sh and run-migrate.sh for the cloud deploy
```

**Why this split**

- **The api and the worker deploy and scale separately.**
  Uploads must stay instant, while extraction is slow and bound by the model's rate limits.
- **Correctness lives in `packages/core` as plain functions.**
  "Is this quote really in the text?" and "did this field change?" are unit-tested without Postgres, Redis or a model.
- **The API contract is written once, in `packages/shared`.**
  The UI validates every response against it instead of trusting a type cast.
- **Every input is parsed with zod where it enters.**
  Route params, the upload form, review bodies, the seed manifest, queue jobs and each service's environment; a bad environment stops startup with every problem listed.
  In the api, routes only map paths, controllers validate and turn results into HTTP, and services hold the logic and never see HTTP.
- **The pipeline does real work.**
  `generate` (the Prisma client) runs before `build`, `typecheck` and `test`; each package builds after its dependencies; `migrate-test` prepares the test database before the integration tests; `lint` runs oxlint everywhere.
  A second `pnpm build` is fully cached.

---

## Data model

<p align="center">
  <img src="docs/db.png" alt="Schema: documents has many document_versions; each version has one extraction_runs row per attempt and one extracted_values row per field; each value has append-only reviews. extracted_values.previous_value_id points at the same field in an earlier version, and reviews.carried_from_review_id points at the review a carried-over review was copied from." width="900">
</p>

| Table | One row per | Worth knowing |
|---|---|---|
| `documents` | thing a client sends revisions of | Points at its current version. |
| `document_versions` | uploaded PDF | Holds the parsed text and the extraction state. |
| `extraction_runs` | attempt | Prompt, raw model response, outcome, error, tokens. |
| `extracted_values` | field of a version | A gap has `value` null and a `gap_reason`; `review_status` caches the latest review, so lists need no join. |
| `reviews` | review action | Append-only; a carried-over review is a new row that points at the original. |

**Why it is shaped this way**

- **A new version never touches the old one.**
  Values belong to a version, so v1, its values and its reviews stay exactly as they were.
- **Lineage is explicit.**
  "What was this field in v1, and who approved it?" is a join on `previous_value_id` and `carried_from_review_id`, not a guess.
- **Duplicates are impossible, not just unlikely.**
  `extracted_values` is unique on `(version_id, field_key)`.
- **Each version keeps its own text.**
  Evidence validation and the review UI for version N always use version N's text, also after N+1 exists.

---

## How extraction runs

### Redis delivers work; Postgres remembers everything

| Redis (BullMQ) | Postgres |
|---|---|
| One job per version, `{versionId}`, with `jobId = versionId` | Version status, lease, attempts and error |
| Removed as soon as the job finishes | Every run: prompt, raw response, outcome, tokens |
| Nothing in it is needed to rebuild the state | Every value and every review |

Losing Redis loses no data: the worker's **reconciler** runs every 15 s and enqueues every version Postgres says needs work (`queued`, or `extracting` with an expired lease).

### The life of a version

<p align="center">
  <img src="docs/The_life_of_a_version.png" alt="Version lifecycle: an upload (202) creates a queued version; it is claimed with a 60 s lease and becomes extracting; from there it ends extracted when values are committed, superseded when a newer version is current, or failed on a parse or model error, and Retry sends a failed version back to queued. If the worker dies, the lease expires and the version is claimed again; after 3 unfinished attempts it fails." width="900">
</p>

### Step by step

1. **Upload.** The PDF goes to MinIO first, then the `queued` version row, then the job; the api answers `202` in about 20-140 ms.
   If the enqueue fails, the upload still succeeds and the reconciler enqueues it.
2. **Claim.** One conditional `UPDATE` moves the version to `extracting` with a 60 s lease, only if it is `queued` or its lease expired, and it has attempts left (3).
   However many jobs exist for a version, only one claim succeeds.
3. **Heartbeat.** A running attempt renews its lease every 20 s.
4. **Parse, then call the model.** The parsed text, the prompt and then the raw response are saved before anything can fail on them.
5. **Validate, carry over, commit.** The evidence is checked first; the carried-over reviews and the values are then committed in one transaction under the document's row lock, with `ON CONFLICT DO NOTHING`.
6. **Fail as a state.** A parse or model error sets the version `failed` with a readable error, such as `llm_request_failed: 401 authentication_error: invalid x-api-key`, and the reviewer retries it from the UI.

### When things fail

Each of these was run against the compose stack.

| Failure | What happens | Observed |
|---|---|---|
| **Worker killed** mid-extraction | The lease stops being renewed and expires; the reconciler re-enqueues; attempt 2 claims it. | Extracted 94 s after `docker compose kill worker`: 60 s lease, up to 15 s to reconcile, then a 25 s model call. |
| **`docker compose restart`** | The worker gets SIGTERM and finishes its running job; a job that outlives Docker's 10 s grace is killed and resumes as above. The seed re-runs and adds nothing. | Finished during shutdown. With `restart -t 0` (immediate kill), extracted 67 s later. |
| **`redis-cli FLUSHALL`** + restart | A job in flight keeps running and commits to Postgres; queued jobs come back through the reconciler. | 1 extracting and 3 queued versions, flushed and hard-restarted: all 4 extracted within 66 s, every value and review intact. |
| **Redis down** | Uploads still succeed and stay `queued`; `/health` answers 503; jobs flow again when Redis is back. | Upload answered `202` in 0.12 s; extracted 13 s after Redis came back. |
| **Postgres down** | The api answers 500 (`/health` 503); the worker cannot claim or commit, so nothing is half-written; leases expire and the reconciler resumes. | Down for 15 s mid-extraction: resumed on attempt 2, extracted 49 s after Postgres came back. |
| **Duplicate jobs, double Retry** | `jobId` dedupes waiting jobs, the claim lets one through, the unique key catches the rest; Retry is one guarded `UPDATE`. | 4 extra jobs for one version: 1 run, 5 values. Two concurrent retries: one `202`, one `409`. |
| **A PDF that crashes the worker** | Only attempts that never finish count; after 3 the version is `failed` with `too_many_attempts`. | Integration test. |

> [!IMPORTANT]
> No version stays `extracting` forever.
> Either a live worker renews its lease, or the lease expires and the version is claimed again, until the attempt cap fails it visibly.
> A killed attempt's run keeps `outcome` null: it never finished, and nothing rewrites history.

---

## Decisions the brief left open

| Decision | Choice |
|---|---|
| [Correction model](#corrections-live-beside-the-value) | A correction lives **beside** the model's value, never over it. |
| [New version while one is extracting](#a-newer-version-supersedes-one-still-extracting) | **Supersede**: the newest upload wins. |
| [Polling, streaming or refresh](#poll-only-while-something-is-in-flight) | **Poll** every 2 s, only while something on screen is in flight. |
| [What "unchanged" means](#what-unchanged-means) | Same value, and the old quote is **still in the new text**. |
| [Where PDFs live](#pdfs-in-minio-parsed-text-in-postgres) | Bytes in **MinIO**, parsed text in **Postgres**. |
| [Hallucination defense](#evidence-validation) | A quote not found in the text becomes a **gap**. |

### Corrections live beside the value

- `extracted_values.value` is always what the model said, and its evidence belongs to it.
- A correction is a `reviews` row with `corrected_value` and an optional note; the effective value is the latest correction, or the model's value.
- The API takes `{"action": "approve"}` or `{"action": "correct", "correctedValue": "...", "note": "..."}`; the UI shows the model's value struck through next to the correction.

**Why:** the quote still matches the value it is shown with, the review history stays intact, and carry-over can compare the model's reading of v1 with its reading of v2.

### A newer version supersedes one still extracting

- An upload becomes the current version at once.
- When the worker reaches the older version's currency check (before the model call, and again at commit under the document lock), it marks it `superseded` and writes no values.
- A previous version that already finished stays `extracted` and is the base for carry-over.
- Uploading bytes identical to the current version is refused with `409`.

**Why:** the reviewer wants the newest file reviewed.
Rejecting would make them wait for an extraction nobody will review, and queueing both would spend a model call on it.

### Poll only while something is in flight

- The UI polls every 2 s while something on screen is `queued` or `extracting`, and stops on its own; the network tab goes quiet once nothing is in flight.
- Queries also refetch when the window regains focus, which is when a document uploaded by someone else shows up.

**Why:** an extraction takes seconds and passes through three states, and a reviewer works on one document at a time, so polling needs no extra infrastructure.
With many reviewers or long-running work I would push changes instead, with server-sent events from Postgres `LISTEN/NOTIFY`.

### What "unchanged" means

For each field, the new value is compared with the same field in the latest earlier extracted version.
It is **unchanged** when both hold:

1. the model's value is the same, ignoring whitespace, and
2. its evidence is the same quote, or the **old quote still appears in the new version's text** and is at least 6 characters long (a shorter one proves nothing).

A gap that is still a gap is unchanged too.
An unchanged value gets the previous review copied forward and is `carried_over`; anything else is `pending`, with the previous value and review shown beside it.

**Why "the old quote is still there":** it holds when the text around it shifts, wraps or gains lines, and when the model quotes a slightly different span of the same passage, while any edit inside the quoted passage breaks it.

What the fixture's revised invoice produces:

| Field | v1 | v2 | Result |
|---|---|---|---|
| Invoice number | INV-2025-0847 | INV-2025-0847 | Carried over |
| Issue date | 2025-09-14 | 2025-09-14 | Carried over |
| Due date | 2025-10-14 | **2025-11-13** | **Pending**, shown with v1's value and review |
| Vendor name | MERIDIAN OFFICE SUPPLIES LLC | MERIDIAN OFFICE SUPPLIES LLC | Carried over |
| Total amount | $5,230.29 | **$6,126.45** | **Pending**, shown with v1's value and review |

### PDFs in MinIO, parsed text in Postgres

- The bytes go to S3-compatible storage as `pdfs/<sha256>.pdf`, written before the database row, so a row never points at a missing object.
- Postgres keeps the key, the hash and the parsed text.

**Why:** the database stays small, and the same code runs against S3 or GCS in production.
The parsed text is stored per version rather than re-parsed, so the evidence offsets and the highlighting always point into exactly the text that was validated.

### Evidence validation

- Each quote must appear in the version's parsed text, ignoring only whitespace differences, since PDF text extraction and the model rarely agree on line breaks.
- A quote shorter than 6 characters after collapsing whitespace (like `2025` or `$5`) can match anywhere, so it becomes a gap with reason `evidence_too_short`; a longer quote that appears more than once is kept at its first match.
- The stored evidence is then the exact slice of the parsed text, with its offsets.
- The value must also appear inside its own quote (case-sensitive, whitespace collapsed, no number or date parsing), or the field becomes a gap with reason `value_not_in_evidence`; the model's claimed value and quote stay in the run's raw response.
- A quote that is not there becomes a gap with reason `evidence_not_found`; a field the model skipped becomes `missing_from_llm_output`; a field the model could not find keeps the model's reason.
- `packages/core/tests/evidence.test.ts` proves a hallucinated quote becomes a gap.

The model is `claude-opus-5-5` with structured output against a zod schema, effort `medium`, and server-side refusal fallback.
An extraction uses about 1,100 input and 260 output tokens, roughly one cent.

---

## Tests

**120 tests**, placed where breakage would be silent or expensive.

| Package | Runs against | Covers |
|---|---|---|
| `packages/core` | Nothing (pure functions) | Evidence validation including a hallucinated quote, carry-over rules, model output parsing, model error messages, PDF text |
| `apps/worker` | Real Postgres and Redis | Racing claims, a worker killed mid-extraction, a Redis flush, the attempt cap, retry |
| `apps/api` | Real Postgres and Redis | Uploads and their failure modes, reviews and the stale-version `409`, carry-over end to end through the worker, retry, the seed |
| `apps/web` | MSW | Polling starts and stops, approve and correct, the stale-version message, what counts as changed, the list order |

```bash
pnpm install
pnpm build    # a second run is fully cached
TEST_DATABASE_URL=postgres://lomi:lomi@127.0.0.1:5432/lomi_test \
TEST_REDIS_URL=redis://127.0.0.1:6379/1 \
pnpm turbo run typecheck lint test
./scripts/chaos.sh    # kills the worker and flushes Redis mid-extraction against the running stack
```

The integration tests need the compose Postgres and Redis; without the two variables they are skipped.
They use their own database and Redis database, because the compose worker would otherwise pick up their rows.

---

## Deployment

The same api, worker and migrate-seed images that run in `docker compose` run on Google Cloud, provisioned by Terraform in [`infra/`](infra).
The review UI is on Vercel.

| | URL |
|---|---|
| **Review UI** | https://lomi-review-pi.vercel.app |
| API | https://api-pqoxlls5ja-el.a.run.app (`GET /health` shows version and queue counts) |

<p align="center">
  <img src="docs/cloud_infra.png" alt="Cloud infrastructure: the browser loads the review UI from Vercel and calls the api on Cloud Run. Inside Google Cloud project lomi-review-1128 (asia-south1), Cloud Run runs the api service, the worker pool and the migrate-and-seed job. The api and worker reach Cloud SQL Postgres 18 and Memorystore Redis 7.2 in a VPC with private IPs only; the migrate job and the apps keep PDFs in Cloud Storage without keys, and secrets come from Secret Manager. The worker calls the Anthropic API. Cloud Build pushes the images to Artifact Registry." width="900">
</p>

| Piece | Google Cloud service |
|---|---|
| API | Cloud Run service with its own HTTPS URL; the startup probe is `/health/live` |
| Worker | Cloud Run worker pool, 1 instance, no HTTP endpoint |
| Migrate + seed | Cloud Run job from the api image, run before the services start |
| Postgres | Cloud SQL Postgres 18, `db-f1-micro`, private IP only, TLS required |
| Redis | Memorystore Redis 7.2, basic 1 GB, private IP only, `maxmemory-policy noeviction` as BullMQ requires |
| PDFs | Cloud Storage bucket, public access prevented, reached as the service account (no key) |
| Secrets | Secret Manager, as Cloud Run secret environment variables |
| Images | Artifact Registry, built for `linux/amd64` by Cloud Build |
| Logs | Cloud Logging |
| Web | Vercel |

Cloud Run reaches Cloud SQL and Memorystore through Direct VPC egress; everything else goes straight out, so there is no NAT gateway.
Neither database has a public IP.
The api's startup probe is `/health/live`, which answers whenever the process does; `/health` answers `503` while Postgres or Redis is down, and replacing the api would not fix that, so uploads keep working while Redis is down.

### Deploy

Once per project (any project with billing linked works):

```bash
gcloud projects create <project-id>
gcloud billing projects link <project-id> --billing-account=<billing-account-id>
gcloud auth application-default login
```

Then, and for every redeploy from step 2:

```bash
export TF_VAR_project_id=<project-id> TF_VAR_anthropic_api_key=sk-ant-...
tag=$(git describe --always --dirty)
terraform -chdir=infra init
terraform -chdir=infra apply                                                  # 1. network, databases, bucket, secrets, registry
scripts/build-images.sh                                                       # 2. Cloud Build, linux/amd64, tagged $tag
terraform -chdir=infra apply -var image_tag=$tag -var start_services=false    # 3. the migrate job, services down
scripts/run-migrate.sh                                                        # 4. migrations and the seed, then its logs
terraform -chdir=infra apply -var image_tag=$tag -var web_origin=https://<vercel-domain>   # 5. api and worker
```

Taking the services down for step 4 means migrations always run before new code serves requests.

The web app builds with the API's URL baked in (`apps/web/vercel.json` holds the build settings, the SPA fallback and the cache headers).
The Vercel project is connected to this GitHub repository with its Root Directory set to `apps/web`, so every push to `main` builds and deploys the web app, with `VITE_API_URL` from the project's production environment.
The new UI goes live as soon as `main` moves, so deploy the api first when a change needs both.
To deploy the web app by hand instead:

```bash
vercel link --cwd apps/web
VITE_API_URL=$(terraform -chdir=infra output -raw api_url) vercel build --prod --cwd apps/web
vercel deploy --prebuilt --prod --cwd apps/web
```

### How secrets flow

Terraform generates the database password and writes `DATABASE_URL` and `ANTHROPIC_API_KEY` to Secret Manager.
Cloud Storage needs no secret at all: the apps use the service account's short-lived token from the metadata server.
Cloud Run revisions name only the secrets; Cloud Run resolves them when an instance starts and sets them as environment variables inside the container, with access granted to the app's service account alone.
They never appear in a revision's plain environment, in the logs or in the repository.
The local Terraform state does hold them, so `infra/.gitignore` keeps state and `*.tfvars` out of git.

### Why the cloud runs the same stack

The images, entry points and environment schemas are the ones compose runs, so what the chaos script proves locally is what runs in the cloud.
The differences are configuration: `GCS_BUCKET` instead of MinIO's `S3_BUCKET` (the one place the code branches, behind the same `putObject`/`getObject` functions), and one allowed CORS origin instead of nginx's same-origin `/api`.
Pub/Sub or Cloud Functions would replace the lease, heartbeat and reconciler design under test with a different system, and a single long-running worker gains nothing from functions.
The first attempt ran on AWS (ECS Fargate); that account was under an AWS security hold that blocked ECS, so it moved to Google Cloud ([spec 010](spec/010-cloud-deployment.md)).

### Checked in the cloud

Run against the deployed stack on 2026-11-28; [spec 010](spec/010-cloud-deployment.md) has the details.

| Check | Result |
|---|---|
| The seeded documents | The migrate job applied 4 migrations and seeded 3 documents; the worker extracted them, and the Vercel UI lists them over HTTPS. |
| Upload the v2 invoice | With v1's 5 values approved, v2 came back with exactly 2 pending and 3 carried over. |
| Stop the worker mid-extraction | The document completed. Cloud Run gives a stopped container 10 seconds, and the 3-second extraction finished inside them; a hard kill mid-extraction is what `scripts/chaos.sh` does locally. |
| Flush Redis | With the worker down and a job waiting, `FLUSHALL` from inside the VPC emptied the queue; the restarted worker's reconciler re-enqueued the version from Postgres and extracted it. |
| Secrets | The api, worker and migrate job carry `DATABASE_URL` and `ANTHROPIC_API_KEY` only as Secret Manager references; 731 log entries contain neither. |

### Cost and teardown

About $3 to $4 a day, mostly Memorystore, the always-on worker and Cloud SQL.

```bash
terraform -chdir=infra destroy -var image_tag=none
```

---

## What I cut, and what is next

| Cut on purpose | What it means today |
|---|---|
| Authentication and reviewer identity | Reviews have no author. |
| Pagination of the document list | The list returns every document. |
| OCR | A scanned PDF without a text layer fails with `no_text_layer`. |
| Normalising dates and amounts before comparing versions | `$5,230.29` and `5230.29` count as a change. |
| Cleanup of orphaned objects | A failed upload transaction can leave its PDF in MinIO. |
| Backoff between crash attempts, metrics beyond `/health` | Crashes retry at once; health is the only signal. |
| CI | Everything is verified locally, and deploys run from a laptop. |

**Next, in order:**

1. Reviewer identity on reviews.
2. CI running the turbo pipeline against service containers, and deploying on merge.
3. The scale work below.

---

## At 10,000 documents

| Area | Change |
|---|---|
| **Document list** | Paginate with a cursor on `(created_at, id)` and filter by status; keep pending and total counts on the version, updated at commit and review, instead of aggregating on every request. |
| **Throughput** | Run more workers (the claim is safe across them), rate-limited to the model's limits with BullMQ's limiter and backoff on 429; use the Batches API for bulk backfills, at half the price. |
| **Cost** | About $100 per 10,000 extractions at today's token counts; log cost per run and alert on outliers. |
| **Updates** | Polling a paginated list still works; with many reviewers, move to server-sent events. |
| **Reconciler** | It already uses the `(status, lease_until)` index; enqueue in batches and let one worker run it under a Postgres advisory lock. |
| **Storage** | Parsed text stays in Postgres (a few KB each); PDFs stay in object storage, with a lifecycle policy for superseded versions. |
| **Review load** | A queue of pending values across documents, changed values first, so several reviewers can work through fields without opening every document. |
