#!/usr/bin/env bash
# Builds the api and worker images on Cloud Build (linux/amd64) and pushes them to the Artifact Registry repository
# that infra/ created. The tag is the commit (git describe --always --dirty); pass the same one to terraform -var image_tag=...
set -euo pipefail
cd "$(dirname "$0")/.."

tag=$(git describe --always --dirty)
out() { terraform -chdir=infra output -raw "$1"; }

gcloud builds submit --project "$(out project_id)" --region "$(out region)" --config cloudbuild.yaml \
  --service-account "$(out build_service_account)" --substitutions "_REGISTRY=$(out registry),_TAG=$tag" .
echo "pushed $tag"
