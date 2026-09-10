#!/usr/bin/env bash
# Source from an entrypoint that has set repo. Values here contain no secrets.
runtime_directory() { printf '%s\n' "${TASKINDEX_RUNTIME_DIR:-$repo/deploy/.runtime}"; }
load_current_release() {
  local state
  state="$(runtime_directory)/current.json"
  if [[ -f $state ]]; then
    export TASKINDEX_IMAGE TASKINDEX_BUILD TASKINDEX_DEPLOYMENT LITESTREAM_REPLICA_URL
    TASKINDEX_IMAGE=$(jq -er '.image' "$state")
    TASKINDEX_BUILD=$(jq -er '.build' "$state")
    TASKINDEX_DEPLOYMENT=$(jq -er '.deployment' "$state")
    LITESTREAM_REPLICA_URL=$(jq -er '.replicaUrl' "$state")
  fi
}
dc() {
  local compose_args=(-f "$repo/deploy/compose.yml")
  if [[ -n ${TASKINDEX_COMPOSE_PROJECT:-} ]]; then compose_args=(-p "$TASKINDEX_COMPOSE_PROJECT" "${compose_args[@]}"); fi
  if [[ -n ${TASKINDEX_COMPOSE_OVERRIDE:-} ]]; then compose_args+=(-f "$TASKINDEX_COMPOSE_OVERRIDE"); fi
  docker compose "${compose_args[@]}" "$@"
}
save_current_release() {
  local state_dir temporary
  state_dir=$(runtime_directory)
  mkdir -p "$state_dir"
  temporary="$state_dir/current.json.$$"
  jq -n --arg image "$TASKINDEX_IMAGE" --arg build "$TASKINDEX_BUILD" --arg deployment "$TASKINDEX_DEPLOYMENT" \
    --arg replicaUrl "$LITESTREAM_REPLICA_URL" --arg status "$1" \
    '{image:$image,build:$build,deployment:$deployment,replicaUrl:$replicaUrl,status:$status}' > "$temporary"
  mv "$temporary" "$state_dir/current.json"
}
wait_health() {
  local writes=$1 build=$2 schema=$3
  for ((attempt=0; attempt<30; attempt++)); do
    if dc exec -T app node -e 'fetch("http://127.0.0.1:3000/health").then(async r=>{const h=await r.json();if(!r.ok||!h.ok||!h.dbWritable||h.writes!==process.argv[1]||h.build!==process.argv[2]||h.schemaVersion!==Number(process.argv[3]))process.exit(1)}).catch(()=>process.exit(1))' "$writes" "$build" "$schema"; then return 0; fi
    sleep 1
  done
  return 1
}
confirmed_sync() {
  local point
  for ((attempt=0; attempt<10; attempt++)); do
    if point=$(dc exec -T litestream litestream sync -wait -json -socket /data/litestream.sock /data/taskindex.db) && \
      jq -e '.replica_txid != null and .replica_txid == .txid' <<<"$point" >/dev/null; then
      printf '%s\n' "$point"
      return 0
    fi
    sleep 1
  done
  return 1
}
