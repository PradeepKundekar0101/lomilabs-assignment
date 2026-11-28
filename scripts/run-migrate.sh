#!/usr/bin/env bash
# Runs the migrate job (migrations, then the fixture seed) once, waits for it, prints its logs, and exits non-zero
# if it failed. Run it while the services are down (start_services=false, see the README's deploy steps).
set -euo pipefail
cd "$(dirname "$0")/.."

out() { terraform -chdir=infra output -raw "$1"; }
project=$(out project_id)
region=$(out region)

status=0
gcloud run jobs execute migrate --project "$project" --region "$region" --wait || status=$?
gcloud logging read --project "$project" --freshness 15m --order asc --limit 200 --format 'value(textPayload)' \
  'resource.type="cloud_run_job" AND resource.labels.job_name="migrate" AND textPayload!=""' | tail -40
if [[ $status -ne 0 ]]; then
  echo "migrate failed" >&2
  exit "$status"
fi
echo "migrate succeeded"
