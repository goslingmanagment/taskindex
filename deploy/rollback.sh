#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
# Runs from the release snapshot of the previous release (deploy/.runtime/releases/<deployment>/):
# deploy.sh on_failure and the drills call the copy there, never the candidate checkout (TI-015).
if [[ ${1:-} == --help ]]; then
  printf '%s\n' 'Internal rollback before open-writes. Called by deploy.sh with a closed-write authorization' \
    'and the backup manifest; configuration comes from the snapshot named by manifest.previousRelease.'
  exit 0
fi
manifest=${1:?Backup manifest path is required}
[[ ${TASKINDEX_ROLLBACK_AUTHORIZATION:-} == pre-open-writes ]] || {
  printf '%s\n' 'Rollback refused: no pre-open-writes authorization.' >&2; exit 1; }
[[ -n ${TASKINDEX_OPEN_BOUNDARY_FILE:-} && ! -e $TASKINDEX_OPEN_BOUNDARY_FILE ]] || {
  printf '%s\n' 'Rollback refused: the write-opening boundary may have been crossed.' >&2; exit 1; }
jq -e '.image and .build and .backup and .replicaUrl and .previousRelease and .database.generation
  and .database.schemaVersion' "$manifest" >/dev/null
previous_release=$(jq -er '.previousRelease' "$manifest")
[[ -f $previous_release/release.json && -f $previous_release/common.sh ]] || {
  printf 'Rollback refused: release snapshot %s is missing.\n' "$previous_release" >&2; exit 1; }
# repo is read by common.sh for defaults only; the compose file and runtime directory are explicit.
# shellcheck disable=SC2034
repo=${TASKINDEX_REPO:-$(cd "$(dirname "$0")/.." && pwd)}
export TASKINDEX_RUNTIME_DIR="${TASKINDEX_RUNTIME_DIR:-$(cd "$(dirname "$manifest")" && pwd)}"
source "$previous_release/common.sh"
verify_release_snapshot "$previous_release"
export TASKINDEX_RELEASE_DIR="$previous_release" TASKINDEX_COMPOSE_FILE="$previous_release/compose.yml"
backup_path=$(jq -er '.backup' "$manifest")
[[ $backup_path == /data/backups/*.db ]] || {
  printf '%s\n' 'Backup must be an independent /data/backups/*.db file.' >&2; exit 1; }
previous_replica=$(jq -er '.replicaUrl' "$manifest")
case "$previous_replica" in
  s3://*|file://*) ;;
  *) printf '%s\n' 'Unverified replica backend: refusing automatic rollback.' >&2; exit 1 ;;
esac
[[ $previous_replica != *'?'* && $previous_replica != *'#'* ]] || {
  printf '%s\n' 'Use endpoint/region configuration fields, not query parameters, before automatic rollback.' >&2
  exit 1
}
restore_id="restore-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
opened=0
failed() {
  local code=$?
  trap - ERR
  if [[ $opened == 0 ]]; then dc stop -t 40 app litestream || true; fi
  printf '%s\n' 'Rollback did not complete. Existing copies and replica history were retained;' \
    'inspect runtime/current.json and deploy/README.md before resuming.' >&2
  exit "$code"
}
trap failed ERR
# No DB connection may survive the file replacement, including the replicator.
dc stop -t 40 app litestream
[[ -z $(docker ps --filter "volume=${TASKINDEX_VOLUME:-taskindex_data}" --format '{{.ID}}') ]] || {
  printf '%s\n' 'Rollback refused: another running container still mounts the database volume.' >&2
  exit 1
}
export TASKINDEX_IMAGE TASKINDEX_BUILD TASKINDEX_DEPLOYMENT LITESTREAM_REPLICA_URL
TASKINDEX_IMAGE=$(jq -er '.image' "$manifest")
TASKINDEX_BUILD=$(jq -er '.build' "$manifest")
TASKINDEX_DEPLOYMENT="$restore_id"
# A sibling prefix starts a fresh replication history; it never deletes or
# nests inside the old prefix, so the old restore chain remains untouched.
LITESTREAM_REPLICA_URL="${previous_replica%/}-$restore_id"
dc run --rm --no-deps -T -e TASKINDEX_OFFLINE_RESTORE=confirmed-no-open-connections app \
  node deploy/database.mjs quarantine-and-install "$backup_path"
restored=$(dc run --rm --no-deps -T app taskindex-admin mark-restored)
new_generation=$(jq -er '.generation' <<<"$restored")
expected_schema=$(jq -er '.database.schemaVersion' "$manifest")
save_current_release recovering
dc up -d app litestream
wait_health held "$TASKINDEX_BUILD" "$expected_schema"
point=$(confirmed_sync)
txid=$(jq -er '.replica_txid' <<<"$point")
printf -v txid_hex '%016x' "$txid"
verification="/data/backups/${restore_id}-replica.db"
dc run --rm --no-deps -T litestream restore -config /etc/litestream.yml -txid "$txid_hex" \
  -integrity-check full -o "$verification" /data/taskindex.db
verified=$(dc run --rm --no-deps -T -e DATABASE_PATH="$verification" app node deploy/database.mjs inspect)
jq -e --arg generation "$new_generation" --argjson schema "$expected_schema" \
  '.generation == $generation and .schemaVersion == $schema' <<<"$verified" >/dev/null
save_current_release opening
# Persist the boundary before invoking open-writes, including its unknown result.
printf '%s\n' "$restore_id" > "$TASKINDEX_OPEN_BOUNDARY_FILE"
opened=1
dc exec -T app taskindex-admin open-writes
wait_health open "$TASKINDEX_BUILD" "$expected_schema"
save_current_release open
trap - ERR
jq -n --arg image "$TASKINDEX_IMAGE" --arg generation "$new_generation" --arg replicaUrl "$LITESTREAM_REPLICA_URL" \
  --arg release "$previous_release" \
  '{ok:true,rolledBack:true,image:$image,generation:$generation,replicaUrl:$replicaUrl,release:$release,writes:"open"}'
