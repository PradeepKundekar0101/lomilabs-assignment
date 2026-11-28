# 010 Cloud deployment

Status: Done (2026-11-28, merged in [PR #12](https://github.com/PradeepKundekar0101/lomilabs-assignment/pull/12); deployed to project `lomi-review-1128`)
Depends on: 002, 003, 006, 007, 008, 009

Revisions:
- Revision 1 (AWS, 2026-11-28): ECS Fargate, RDS, ElastiCache, S3, an ALB, API Gateway (CloudFront was refused), applied in account 480073428925.
  ECS then refused every task: AWS had put the account on a suspension warning after a suspected compromise.
  Everything was destroyed with `terraform destroy`.
- Revision 2 (Google Cloud, 2026-11-28, approved by the user): this document.

## Goal

The same api, worker and migrate-seed images that run in `docker compose` run on Google Cloud, provisioned by Terraform in `infra/`, with the review UI on Vercel.
The resilience behaviors from spec 007 (a killed worker, a flushed Redis) hold in the cloud as they do locally.

## Requirements

1. **Target architecture.**

   | Piece | Google Cloud service |
   |-------|----------------------|
   | API | Cloud Run service, public HTTPS (`*.run.app`), 0 to 2 instances |
   | Worker | Cloud Run worker pool (no HTTP endpoint), 1 instance |
   | Migrate + seed | Cloud Run job from the api image (as in compose), run before the services start |
   | Postgres | Cloud SQL Postgres 18, `db-f1-micro`, private IP only, TLS required |
   | Redis | Memorystore for Redis 7.2, basic 1 GB, private IP only, `maxmemory-policy noeviction` (BullMQ requires it) |
   | PDFs | Cloud Storage bucket, public access prevented, read and written through its JSON API as the service account (no key) |
   | Secrets | Secret Manager, into Cloud Run's secret environment variables |
   | Images | Artifact Registry, built for `linux/amd64` by Cloud Build |
   | Logs | Cloud Logging (automatic for Cloud Run) |
   | Web | Vercel |

2. **Networking.** A VPC with one subnet for Cloud Run's Direct VPC egress and a private services access range for Cloud SQL and Memorystore.
   Cloud Run sends only private ranges into the VPC; Cloud Storage and the Anthropic API are reached directly, so there is no NAT.
   Cloud SQL and Memorystore have no public IP.
3. **Code changes.**
   - S3: `S3_ENDPOINT`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` are optional in the api and worker environment schemas; without keys the SDK's default credential chain is used.
     `forcePathStyle` is set only when `S3_ENDPOINT` is set. The region comes from `AWS_REGION` (default `us-east-1`). Setting only one of the two keys is an environment error.
   - Cloud Storage: with `GCS_BUCKET` set instead of `S3_BUCKET` (exactly one of the two), PDFs are put and got through Cloud Storage's JSON API with the service account's token from the metadata server (`gcsBucket` in `packages/core`).
   - CORS: when `WEB_ORIGIN` is set, the api answers that origin's requests with `Access-Control-Allow-Origin` and answers preflight `OPTIONS` requests (methods `GET, POST`, header `Content-Type`).
     Without `WEB_ORIGIN` nothing changes (compose serves the UI same-origin through nginx).
   - `GET /health/live` answers `200` whenever the process answers; it is Cloud Run's startup probe.
     `/health` keeps answering `503` while Postgres or Redis is down, which must not get the api replaced, so uploads keep working while Redis is down (spec 007).
   - The api image also carries `fixtures/` (24 KB), so the migrate job needs no volume. Compose keeps its read-only mount.
4. **Images.** Built by Cloud Build (`cloudbuild.yaml`, `scripts/build-images.sh`) for `linux/amd64`, tagged with `git describe --always --dirty`, never `latest`.
5. **Configuration.** `DATABASE_URL` and `ANTHROPIC_API_KEY` reach the containers only as Secret Manager references.
   `REDIS_URL`, `GCS_BUCKET`, `LEASE_SECONDS`, `RECONCILE_SECONDS`, `LLM_MODEL` and `WEB_ORIGIN` are plain environment.
   The database password comes from `random_password`.
   Cloud SQL requires TLS, so `DATABASE_URL` ends in `?sslmode=require&uselibpqcompat=true` (encrypted; node-postgres does not verify the server certificate).
6. **Identity.** The api, worker and migrate job run as one service account with object access to the bucket and read access to the two secrets.
   Cloud Build runs as its own service account that can push to the repository, write logs and read the uploaded source.
   The api is public through `invoker_iam_disabled`, not an `allUsers` binding (organization policies often forbid those).
7. **Deploy order.** The project is created once with `gcloud` (billing linked); the tag is `git describe --always --dirty`.
   1. `terraform apply`: APIs, network, Cloud SQL, Memorystore, bucket, secrets, registry, service accounts; no Cloud Run resources yet.
   2. `scripts/build-images.sh`.
   3. `terraform apply -var image_tag=<tag> -var start_services=false`: the migrate job, with the api and worker down.
   4. `scripts/run-migrate.sh`: migrations and the seed, before any service runs the new code.
   5. `terraform apply -var image_tag=<tag> -var web_origin=https://<vercel-domain>`: the api and the worker.
   A redeploy is steps 2 to 5.
8. **Web on Vercel.** `apps/web/vercel.json` rewrites every path to `index.html` and sets `immutable` on `/assets/`.
   The bundle is built with `VITE_API_URL=<api url>`; the api runs with `WEB_ORIGIN=<vercel url>`.
9. **Documentation.** The root `README.md` gets a Deployment section: a diagram, the deploy steps, how secrets flow, why the cloud runs the same images, why not a managed queue or functions, the costs and `terraform destroy`.

## Out of scope

- A custom domain (Cloud Run's `*.run.app` URL has a certificate).
- Remote Terraform state (local in `infra/`, gitignored; it holds secrets).
- Autoscaling the worker, high availability for Cloud SQL or Memorystore, backups beyond the defaults.
- CI/CD; deploys run from the developer's machine.

## Design notes

- **Why Cloud Run.** HTTPS URLs come built in, so nothing like CloudFront or API Gateway is needed in front, and worker pools fit a pull-based worker that serves no HTTP.
- **Cloud Storage through its JSON API, not its S3 API.** The S3 API needs an HMAC key, and the organization's `iam.disableServiceAccountKeyCreation` policy refused one on the first apply.
  The JSON API takes the service account's own short-lived token from the metadata server, so no key exists; `putObject` and `getObject` were already functions, so compose keeps MinIO over S3 unchanged.
  A few lines of `fetch` instead of the `@google-cloud/storage` package, which would be the only dependency for two calls.
- **Graceful shutdown.** Cloud Run gives a container 10 seconds after `SIGTERM`; a job still running then is killed, its lease expires and the reconciler resumes it (spec 007), which is the "kill the worker" check.
- **Redis flush.** Memorystore is reachable only from the VPC; the check runs the migrate job with its arguments overridden to a one-line `FLUSHALL` with the bundled ioredis.
- **Why not Pub/Sub or Cloud Functions.** BullMQ on Redis with Postgres as the source of truth is the design under test locally (lease, heartbeat, reconciler); swapping the queue in the cloud would make it a different system, and a single long-running worker gains nothing from functions.

## Acceptance criteria

Verified on 2026-11-28 against project `lomi-review-1128` (api `https://api-pqoxlls5ja-el.a.run.app`, UI `https://lomi-review-pi.vercel.app`), images `0ce591d-dirty`.

- [x] `pnpm turbo run build typecheck lint test` passes: 120 tests against the compose Postgres and Redis, none skipped (new: `gcsBucket`, CORS, `/health/live`, the S3 and bucket environment rules).
- [x] Compose still works end to end: all images rebuilt and recreated, an upload extracted through MinIO, the UI and `/api` served by nginx, no CORS headers without `WEB_ORIGIN`.
- [x] `terraform validate` is clean, and the deploy ran as the five steps of requirement 7.
- [x] Cloud: the migrate job applied the 4 migrations and seeded the 3 fixture documents (uploading their PDFs to Cloud Storage as the service account); the worker extracted all three, and the Vercel UI lists them over HTTPS, with CORS allowing only that origin (preflight `204`).
- [x] Cloud: after approving invoice v1's 5 values through the API, uploading `invoice-001.v2.pdf` left exactly 2 pending and 3 carried over.
- [x] Cloud: the worker pool scaled to 0 one second after extraction began, then back to 1; the document completed. The logs show the extraction finished (3 seconds) before `SIGTERM` arrived, inside Cloud Run's 10-second grace, so this exercised the graceful path. Cloud Run cannot SIGKILL an instance on demand, so the lease-expiry path stays covered by `scripts/chaos.sh` and the resilience tests.
- [x] Cloud: with the worker at 0, an upload's job waited in Redis (`waiting: 1`); the migrate job with its arguments overridden ran `FLUSHALL` (`OK`, `waiting: 0`, the version still `queued` in Postgres); on restart the worker logged `reconciler: re-enqueued 1 version` and extracted it.
- [x] Cloud: the api, worker pool and migrate job carry `DATABASE_URL` and `ANTHROPIC_API_KEY` only as Secret Manager references; 731 log entries from the 2 hours of the deploy contain neither the database password, the key, nor `sk-ant`.

## Open questions

Answered by the user on 2026-11-28: move to Google Cloud (revision 2); install the Google Cloud SDK; deploy into a new project, not the flagged `gsc-mcp-501313`; host the web app in the personal Vercel scope.
