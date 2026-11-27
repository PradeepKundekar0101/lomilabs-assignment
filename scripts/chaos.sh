#!/usr/bin/env bash
# Manual chaos check for spec 007 against the running docker compose stack (real worker, real model).
#   1. Upload fixtures, kill the worker mid-extraction (SIGKILL), start it again.
#   2. Upload more, FLUSHALL Redis mid-extraction, restart the worker.
#   3. Wait until no version is queued or extracting, then print every document's final state.
# Exits non-zero if anything is still queued or extracting after SETTLE_SECONDS.
set -euo pipefail
cd "$(dirname "$0")/.."

API="http://127.0.0.1:${API_PORT:-3000}"
SETTLE_SECONDS="${SETTLE_SECONDS:-120}"

psql() { docker compose exec -T postgres psql -U "${POSTGRES_USER:-lomi}" -d "${POSTGRES_DB:-lomi}" "$@"; }
sql() { psql -At "$@"; }
pending() { sql -c "SELECT count(*) FROM document_versions WHERE status IN ('queued', 'extracting')"; }
log() { echo "[$(date +%T)] $*"; }

upload_batch() {
  local type file
  for pair in invoice:invoice-001.pdf lease:lease-excerpt-001.pdf market_report:market-report-excerpt-001.pdf; do
    type="${pair%%:*}" file="${pair#*:}"
    curl -sf --form-string "type=$type" -F "file=@fixtures/documents/$file" "$API/documents" >/dev/null
  done
  log "uploaded 3 documents"
}

wait_for_extracting() {
  for _ in $(seq 1 100); do
    [ "$(sql -c "SELECT count(*) FROM document_versions WHERE status = 'extracting'")" -gt 0 ] && return 0
    sleep 0.2
  done
  echo "no version started extracting within 20 s; is the worker running?" >&2
  exit 1
}

curl -sf "$API/health" >/dev/null || { echo "api not reachable at $API; start the stack first" >&2; exit 1; }

upload_batch
wait_for_extracting
docker compose kill worker >/dev/null 2>&1
log "killed the worker mid-extraction ($(pending) versions queued or extracting)"
sleep 2
docker compose start worker >/dev/null 2>&1
log "started the worker"

upload_batch
wait_for_extracting
docker compose exec -T redis redis-cli FLUSHALL >/dev/null
log "flushed Redis mid-extraction ($(pending) versions queued or extracting)"
docker compose restart worker >/dev/null 2>&1
log "restarted the worker"

start=$SECONDS
while [ "$(pending)" -gt 0 ]; do
  if [ $((SECONDS - start)) -ge "$SETTLE_SECONDS" ]; then
    log "still $(pending) versions queued or extracting after ${SETTLE_SECONDS} s"
    break
  fi
  sleep 5
done
left="$(pending)"
[ "$left" -eq 0 ] && log "settled $((SECONDS - start)) s after the last restart"

psql -P footer=off -c "
  SELECT d.id, v.version_no AS v, v.status, v.attempts, count(x.id) AS values, coalesce(v.error, '') AS error
  FROM documents d
  JOIN document_versions v ON v.id = d.current_version_id
  LEFT JOIN extracted_values x ON x.version_id = v.id
  GROUP BY d.id, v.id
  ORDER BY d.created_at"
[ "$left" -eq 0 ]
