#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
if [[ ${1:-} == --help ]]; then
  printf '%s\n' 'Usage: deploy/local-drill.sh [--skip-build]' 'Creates an isolated named Docker volume and local Litestream replica. Never deletes volumes or backups.'
  exit 0
fi
repo=$(cd "$(dirname "$0")/.." && pwd)
for tool in docker jq; do command -v "$tool" >/dev/null || { printf 'Missing: %s\n' "$tool" >&2; exit 1; }; done
project="taskindex-drill-$(date -u +%Y%m%d%H%M%S)-$RANDOM"
export TASKINDEX_VOLUME="${project}_data" TASKINDEX_DEPLOYMENT="$project"
export TASKINDEX_IMAGE=${TASKINDEX_IMAGE:-taskindex:v2-drill} TASKINDEX_BUILD=${TASKINDEX_BUILD:-local-drill}
export BASE_URL=http://localhost:3000 BETTER_AUTH_SECRET=local-drill-secret-not-a-production-credential-123456789
export AWS_ACCESS_KEY_ID=local-drill AWS_SECRET_ACCESS_KEY=local-drill
export LITESTREAM_REPLICA_URL="file:///data/test-replica/$project"
export TASKINDEX_COMPOSE_PROJECT="$project" TASKINDEX_COMPOSE_OVERRIDE="$repo/deploy/compose.local.yml"
export TASKINDEX_RUNTIME_DIR="${TMPDIR:-/tmp}/$project"
mkdir -p "$TASKINDEX_RUNTIME_DIR"
source "$repo/deploy/common.sh"
failed() {
  local code=$?
  trap - ERR
  dc stop -t 40 app litestream || true
  printf 'Drill failed; retained project=%s volume=%s\n' "$project" "$TASKINDEX_VOLUME" >&2
  exit "$code"
}
trap failed ERR
if [[ ${1:-} != --skip-build ]]; then dc build app; fi
dc run --rm --no-deps -T app taskindex-admin migrate
printf '%s\n' 'local-drill-password-only' | dc run --rm --no-deps -T app taskindex-admin create-owner --email owner@example.test
dc run --rm --no-deps -T app taskindex-admin agent create --id drill-agent --label 'Локальная проверка'
dc run --rm --no-deps -T app taskindex-admin agent-key create --agent drill-agent --scope write --out /data/drill-key.json
dc up -d app litestream
health() {
  local expected=$1
  for ((attempt=0; attempt<30; attempt++)); do
    if dc exec -T app node -e 'fetch("http://127.0.0.1:3000/health").then(async r=>{const h=await r.json();if(!h.ok||h.writes!==process.argv[1])process.exit(1)}).catch(()=>process.exit(1))' "$expected"; then return 0; fi
    sleep 1
  done
  return 1
}
health held
dc exec -T app taskindex-admin open-writes
health open
agent_create() {
  dc exec -T app node --input-type=module - "$1" <<'JS'
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const token = JSON.parse(readFileSync('/data/drill-key.json', 'utf8')).key;
const child = spawnSync(process.execPath, ['dist/cli/index.js', 'task', 'create', '--area', 'agency', '--title', 'Проверка резервной копии', '--operation-id', process.argv[2]], {env:{...process.env,TASKINDEX_URL:'http://127.0.0.1:3000',TASKINDEX_TOKEN:token,XDG_STATE_HOME:'/data/cli-state'},stdio:'inherit'});
process.exit(child.status ?? 1);
JS
}
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
  --arg replicaUrl "$LITESTREAM_REPLICA_URL" --argjson database "$metadata" --argjson replication "$point" \
  '{image:$image,build:$build,deployment:$deployment,replicaUrl:$replicaUrl,backup:"/data/backups/drill-point.db",database:$database,replication:$replication}' > "$TASKINDEX_RUNTIME_DIR/last-backup.json"
dc run --rm --no-deps -T -e DATABASE_PATH=/data/backups/drill-point.db app taskindex-admin export --out /data/backups/drill-reference.json
dc run --rm --no-deps -T litestream restore -config /etc/litestream.yml -txid "$txid_hex" -o /data/backups/drill-restored.db /data/taskindex.db
dc run --rm --no-deps -T -e DATABASE_PATH=/data/backups/drill-restored.db app taskindex-admin export --out /data/backups/drill-restored.json
dc run --rm --no-deps -T app node --input-type=module - <<'JS'
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
const a = JSON.parse(readFileSync('/data/backups/drill-reference.json', 'utf8'));
const b = JSON.parse(readFileSync('/data/backups/drill-restored.json', 'utf8'));
delete a.exportedAt; delete b.exportedAt;
if (!isDeepStrictEqual(a,b)) throw new Error('Replicated restore differs from the offline checkpoint');
console.log(JSON.stringify({ok:true,stage:'restored-export-equals-checkpoint',generation:a.generation,seq:a.seq}));
JS
# Inject a failed migrated candidate: its image must refuse this newer schema.
# The production deployment error handler invokes exactly the same rollback.sh.
dc run --rm --no-deps -T app node --input-type=module - <<'JS'
import Database from 'better-sqlite3';
const db=new Database('/data/taskindex.db');
db.exec("CREATE TABLE injected_failed_migration(id INTEGER); UPDATE settings SET value='999' WHERE key='schema_version'");
db.close();
JS
export TASKINDEX_DEPLOYMENT="${project}-failed-candidate"
export TASKINDEX_OPEN_BOUNDARY_FILE="$TASKINDEX_RUNTIME_DIR/opening-failed-candidate"
dc up -d app litestream
sleep 1
if dc exec -T app node -e 'fetch("http://127.0.0.1:3000/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then
  printf '%s\n' 'Injected incompatible schema unexpectedly passed candidate health' >&2
  exit 1
fi
TASKINDEX_ROLLBACK_AUTHORIZATION=pre-open-writes bash "$repo/deploy/rollback.sh" "$TASKINDEX_RUNTIME_DIR/last-backup.json"
load_current_release
health open
agent_create drill-after-restore
# Once opening may have happened, even an explicit rollback invocation refuses.
if TASKINDEX_ROLLBACK_AUTHORIZATION=pre-open-writes bash "$repo/deploy/rollback.sh" "$TASKINDEX_RUNTIME_DIR/last-backup.json"; then
  printf '%s\n' 'Rollback incorrectly accepted an already-opened deployment' >&2
  exit 1
fi
dc stop -t 20 app
point=$(dc exec -T litestream litestream sync -wait -json -socket /data/litestream.sock /data/taskindex.db)
jq -e '.replica_txid != null and .replica_txid == .txid' <<<"$point" >/dev/null
txid=$(jq -er '.replica_txid' <<<"$point")
printf -v txid_hex '%016x' "$txid"
dc stop -t 40 litestream
dc run --rm --no-deps -T litestream restore -config /etc/litestream.yml -txid "$txid_hex" -o /data/backups/drill-new-replica.db /data/taskindex.db
dc run --rm --no-deps -T -e DATABASE_PATH=/data/backups/drill-new-replica.db app taskindex-admin export --out /data/backups/drill-new-replica.json
dc run --rm --no-deps -T app node --input-type=module - <<'JS'
import { readFileSync } from 'node:fs';
const before=JSON.parse(readFileSync('/data/backups/drill-reference.json','utf8'));
const after=JSON.parse(readFileSync('/data/backups/drill-new-replica.json','utf8'));
if(before.generation===after.generation||after.tasks.length!==before.tasks.length+1)throw new Error('Replication after restore lost the new generation or command');
console.log(JSON.stringify({ok:true,stage:'new-replica-verified',generation:after.generation,seq:after.seq}));
JS
trap - ERR
jq -n --arg project "$project" --arg volume "$TASKINDEX_VOLUME" --arg runtime "$TASKINDEX_RUNTIME_DIR" '{ok:true,project:$project,volume:$volume,runtime:$runtime,stopped:true,scope:"local file replica, failed migrated candidate rollback, persistent gate and post-open refusal; production S3 still needs rehearsal"}'
