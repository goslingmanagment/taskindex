#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
skip_build=false heartbeat=false
for argument in "$@"; do
  case $argument in
    --help)
      printf '%s\n' 'Usage: deploy/local-drill.sh [--skip-build] [--heartbeat]' \
        'Creates an isolated named Docker volume and local Litestream replica. Never deletes volumes or backups.' \
        '--heartbeat additionally proves the Litestream dead-man switch: ping while healthy, silence while' \
        'the replica is unreachable, ping again after recovery (about 8 minutes).'
      exit 0 ;;
    --skip-build) skip_build=true ;;
    --heartbeat) heartbeat=true ;;
    *) printf 'Unknown argument: %s\n' "$argument" >&2; exit 1 ;;
  esac
done
repo=$(cd "$(dirname "$0")/.." && pwd)
for tool in docker jq; do command -v "$tool" >/dev/null || { printf 'Missing: %s\n' "$tool" >&2; exit 1; }; done
project="taskindex-drill-$(date -u +%Y%m%d%H%M%S)-$RANDOM"
export TASKINDEX_VOLUME="${project}_data" TASKINDEX_DEPLOYMENT="$project"
export TASKINDEX_IMAGE=${TASKINDEX_IMAGE:-taskindex:v2-drill} TASKINDEX_BUILD=${TASKINDEX_BUILD:-local-drill}
export BASE_URL=http://localhost:3000
export BETTER_AUTH_SECRET=local-drill-secret-not-a-production-credential-123456789
export AWS_ACCESS_KEY_ID=local-drill AWS_SECRET_ACCESS_KEY=local-drill
export LITESTREAM_REPLICA_URL="file:///data/test-replica/$project"
# Пинги Litestream принимает сервис heartbeat из compose.local.yml
# (deploy/drill/heartbeat-receiver.mjs).
export LITESTREAM_HEARTBEAT_URL=http://heartbeat:8787/ping
export TASKINDEX_COMPOSE_PROJECT="$project" TASKINDEX_COMPOSE_OVERRIDE="$repo/deploy/compose.local.yml"
export TASKINDEX_DEPLOY_DIR="$repo/deploy"
export TASKINDEX_RUNTIME_DIR="${TMPDIR:-/tmp}/$project"
export TASKINDEX_REPO="$repo"
mkdir -p "$TASKINDEX_RUNTIME_DIR"
source "$repo/deploy/common.sh"
failed() {
  local code=$?
  trap - ERR
  dc stop -t 40 app litestream heartbeat || true
  printf 'Drill failed; retained project=%s volume=%s\n' "$project" "$TASKINDEX_VOLUME" >&2
  exit "$code"
}
trap failed ERR
if [[ $skip_build != true ]]; then dc_build; fi
[[ $(image_revision "$TASKINDEX_IMAGE") == "$TASKINDEX_BUILD" ]] || {
  printf 'Image %s lacks label org.opencontainers.image.revision=%s\n' "$TASKINDEX_IMAGE" "$TASKINDEX_BUILD" >&2
  exit 1
}
# Programs of the drill run from the checkout, mounted read-only; the image is not rebuilt for them.
drill() { dc run --rm --no-deps -T -v "$repo/deploy/drill:/drill:ro" "$@"; }
dc run --rm --no-deps -T app taskindex-admin migrate
printf '%s\n' 'local-drill-password-only' | \
  dc run --rm --no-deps -T app taskindex-admin create-owner --email owner@example.test
dc run --rm --no-deps -T app taskindex-admin agent create --id drill-agent --label 'Локальная проверка'
dc run --rm --no-deps -T app taskindex-admin agent-key create --agent drill-agent --scope write \
  --out /data/drill-key.json
expected_schema=$(dc run --rm --no-deps -T app node deploy/database.mjs inspect | jq -er '.schemaVersion')
# The running release is recorded like bootstrap.sh does: snapshot plus current.json.
release=$(snapshot_release "$project" "$repo/deploy" local-drill)
export TASKINDEX_RELEASE_DIR="$release" TASKINDEX_COMPOSE_FILE="$release/compose.yml"
save_current_release candidate
dc up -d app litestream heartbeat
health() { wait_health "$1" "$TASKINDEX_BUILD" "$expected_schema"; }
health held
dc exec -T app taskindex-admin open-writes
health open
save_current_release open
agent_create() { drill app node /drill/agent-create.mjs "$1"; }
heartbeat_count() {
  dc exec -T heartbeat sh -c 'if [ -f /tmp/heartbeat.log ]; then wc -l < /tmp/heartbeat.log; else echo 0; fi' | \
    tr -dc '0-9'
}
wait_heartbeat() {
  # wait_heartbeat BASELINE SECONDS: success once the ping count exceeds BASELINE.
  local baseline=$1 seconds=$2
  for ((attempt=0; attempt<seconds; attempt++)); do
    if (( $(heartbeat_count) > baseline )); then return 0; fi
    sleep 1
  done
  return 1
}
heartbeat_drill() {
  # heartbeat-interval is 1m: (a) a ping arrives while the replica is healthy; (b) with the replica
  # directory unreadable, /health stays green but pings stop; (c) pings resume after chmod back;
  # (d) idle: app paused (no healthcheck writes either), do pings still arrive without writes.
  local before healthy=false broken=false recovered=false idle=false
  if wait_heartbeat 0 90; then healthy=true; fi
  dc run --rm --no-deps --user root -T app chmod 000 "/data/test-replica/$project"
  agent_create drill-heartbeat-broken
  health open
  # One full interval of settling: a tick right after the break may still see a recent sync.
  sleep 75
  before=$(heartbeat_count)
  sleep 90
  if (( $(heartbeat_count) > before )); then broken=true; fi
  dc run --rm --no-deps --user root -T app chmod 755 "/data/test-replica/$project"
  before=$(heartbeat_count)
  if wait_heartbeat "$before" 120; then recovered=true; fi
  dc pause app
  before=$(heartbeat_count)
  sleep 130
  if (( $(heartbeat_count) > before )); then idle=true; fi
  dc unpause app
  health open
  heartbeat_result=$(jq -nc --argjson healthy "$healthy" --argjson broken "$broken" \
    --argjson recovered "$recovered" --argjson idle "$idle" \
    '{healthy:$healthy,broken:$broken,recovered:$recovered,idle:$idle}')
  printf 'heartbeat: %s\n' "$heartbeat_result"
  if [[ $healthy != true || $broken != false || $recovered != true ]]; then
    printf '%s\n' 'Heartbeat drill failed: expected a ping while healthy, none while broken, and one after recovery' >&2
    return 1
  fi
}
heartbeat_result=null
if [[ $heartbeat == true ]]; then heartbeat_drill; fi
agent_create drill-before-restore
dc restart app
health open
dc stop -t 20 app
point=$(dc exec -T litestream litestream sync -wait -json -socket /data/litestream.sock /data/taskindex.db)
jq -e '.replica_txid != null and .replica_txid == .txid' <<<"$point" >/dev/null
txid=$(jq -er '.replica_txid' <<<"$point")
printf -v txid_hex '%016x' "$txid"
dc stop -t 40 litestream
metadata=$(dc run --rm --no-deps -T app node deploy/database.mjs backup /data/backups/drill-point.db)
jq -n --arg image "$TASKINDEX_IMAGE" --arg build "$TASKINDEX_BUILD" --arg deployment "$TASKINDEX_DEPLOYMENT" \
  --arg replicaUrl "$LITESTREAM_REPLICA_URL" --arg previousRelease "$release" \
  --argjson database "$metadata" --argjson replication "$point" \
  '{image:$image,build:$build,deployment:$deployment,previousRelease:$previousRelease,replicaUrl:$replicaUrl,
    backup:"/data/backups/drill-point.db",database:$database,replication:$replication}' \
  > "$TASKINDEX_RUNTIME_DIR/last-backup.json"
dc run --rm --no-deps -T -e DATABASE_PATH=/data/backups/drill-point.db app taskindex-admin export \
  --out /data/backups/drill-reference.json
dc run --rm --no-deps -T litestream restore -config /etc/litestream.yml -txid "$txid_hex" \
  -o /data/backups/drill-restored.db /data/taskindex.db
dc run --rm --no-deps -T -e DATABASE_PATH=/data/backups/drill-restored.db app taskindex-admin export \
  --out /data/backups/drill-restored.json
drill app node /drill/compare-exports.mjs /data/backups/drill-reference.json /data/backups/drill-restored.json
# Inject a failed migrated candidate: its image must refuse this newer schema.
# The production deployment error handler invokes exactly the same rollback.sh, from the snapshot.
dc run --rm --no-deps -T app sqlite3 /data/taskindex.db \
  "CREATE TABLE injected_failed_migration(id INTEGER); UPDATE settings SET value='999' WHERE key='schema_version'"
export TASKINDEX_DEPLOYMENT="${project}-failed-candidate"
export TASKINDEX_OPEN_BOUNDARY_FILE="$TASKINDEX_RUNTIME_DIR/opening-failed-candidate"
dc up -d app litestream
sleep 1
if dc exec -T app node deploy/health.mjs 2>/dev/null; then
  printf '%s\n' 'Injected incompatible schema unexpectedly passed candidate health' >&2
  exit 1
fi
TASKINDEX_ROLLBACK_AUTHORIZATION=pre-open-writes bash "$release/rollback.sh" "$TASKINDEX_RUNTIME_DIR/last-backup.json"
load_current_release
[[ $(jq -r '.release' "$TASKINDEX_RUNTIME_DIR/current.json") == "$release" ]] || {
  printf '%s\n' 'current.json after rollback does not name the release snapshot' >&2; exit 1; }
health open
agent_create drill-after-restore
# Once opening may have happened, even an explicit rollback invocation refuses.
if TASKINDEX_ROLLBACK_AUTHORIZATION=pre-open-writes bash "$release/rollback.sh" \
  "$TASKINDEX_RUNTIME_DIR/last-backup.json"; then
  printf '%s\n' 'Rollback incorrectly accepted an already-opened deployment' >&2
  exit 1
fi
dc stop -t 20 app
point=$(dc exec -T litestream litestream sync -wait -json -socket /data/litestream.sock /data/taskindex.db)
jq -e '.replica_txid != null and .replica_txid == .txid' <<<"$point" >/dev/null
txid=$(jq -er '.replica_txid' <<<"$point")
printf -v txid_hex '%016x' "$txid"
dc stop -t 40 litestream
dc run --rm --no-deps -T litestream restore -config /etc/litestream.yml -txid "$txid_hex" \
  -o /data/backups/drill-new-replica.db /data/taskindex.db
dc run --rm --no-deps -T -e DATABASE_PATH=/data/backups/drill-new-replica.db app taskindex-admin export \
  --out /data/backups/drill-new-replica.json
drill app node /drill/verify-new-replica.mjs /data/backups/drill-reference.json /data/backups/drill-new-replica.json
dc stop -t 5 heartbeat
trap - ERR
scope='local file replica, release snapshot, failed migrated candidate rollback from the snapshot, persistent gate'
scope+=' and post-open refusal; production S3 and the real heartbeat receiver still need rehearsal'
jq -n --arg project "$project" --arg volume "$TASKINDEX_VOLUME" --arg runtime "$TASKINDEX_RUNTIME_DIR" \
  --arg release "$release" --argjson heartbeat "$heartbeat_result" --arg scope "$scope" \
  '{ok:true,project:$project,volume:$volume,runtime:$runtime,release:$release,stopped:true,
    heartbeat:$heartbeat,scope:$scope}'
