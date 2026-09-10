#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# First installation on the VPS: the README procedure with the guards of deploy.sh. Ends with
# a release snapshot and current.json, so the next deploy.sh works from recorded state.
# Owner password on stdin (for example the output of `op read`); never as an argument.
usage() {
  printf '%s\n' \
    'Usage: op run --env-file=/protected/taskindex.env -- bash deploy/bootstrap.sh --image REF|ARCHIVE \' \
    '         --owner-email ADDRESS [--owner-name NAME] [--commit SHA] [--build-here]' \
    '         [--agent ID --label LABEL --scope read|tasks|write --out /data/NAME.json]' \
    '         [--open-writes] [--existing-database] < owner-password' \
    '  --image           image built by CI for the checked-out commit (tag, registry ref or archive)' \
    '  --commit          commit the image was built from (default HEAD); the checkout must be on it' \
    '  --build-here      emergency only: build the image on this host' \
    '  --open-writes     open writes at the end; otherwise the app stays held for manual checks' \
    '  --existing-database  allow a volume that already holds /data/taskindex.db (migrations apply)' \
    'Refuses when an app container is running or current.json exists: use deploy.sh then.'
}
main() {
  local image='' commit_ref=HEAD owner_email='' owner_name='' agent_id='' agent_label='' agent_scope=''
  local key_out='' open_writes=false build_here=false existing=false
  while (($#)); do
    case $1 in
      --help) usage; return 0 ;;
      --image) image=${2:?}; shift 2 ;;
      --commit) commit_ref=${2:?}; shift 2 ;;
      --owner-email) owner_email=${2:?}; shift 2 ;;
      --owner-name) owner_name=${2:?}; shift 2 ;;
      --agent) agent_id=${2:?}; shift 2 ;;
      --label) agent_label=${2:?}; shift 2 ;;
      --scope) agent_scope=${2:?}; shift 2 ;;
      --out) key_out=${2:?}; shift 2 ;;
      --open-writes) open_writes=true; shift ;;
      --build-here) build_here=true; shift ;;
      --existing-database) existing=true; shift ;;
      *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; return 1 ;;
    esac
  done
  [[ -n $owner_email ]] || { printf '%s\n' '--owner-email is required.' >&2; return 1; }
  [[ -n $image || $build_here == true ]] || { printf '%s\n' '--image or --build-here is required.' >&2; return 1; }
  if [[ -n $agent_id || -n $agent_label || -n $agent_scope || -n $key_out ]]; then
    [[ -n $agent_id && -n $agent_label && -n $agent_scope && -n $key_out ]] || {
      printf '%s\n' '--agent, --label, --scope and --out go together.' >&2; return 1; }
    [[ $key_out == /data/* ]] || { printf '%s\n' '--out must be a path inside /data (the volume).' >&2; return 1; }
  fi
  local repo target runtime tool
  repo=$(git rev-parse --show-toplevel)
  cd "$repo"
  source "$repo/deploy/common.sh"
  for tool in docker git jq flock; do
    command -v "$tool" >/dev/null || { printf 'Missing command: %s\n' "$tool" >&2; return 1; }
  done
  [[ $(uname -s) == Linux ]] || { printf '%s\n' 'Run the installation on the Linux VPS.' >&2; return 1; }
  git diff --quiet && git diff --cached --quiet || {
    printf '%s\n' 'Checkout contains changes; installation stopped.' >&2; return 1; }
  target=$(git rev-parse --verify --quiet "$commit_ref^{commit}") || {
    printf 'Unknown commit: %s\n' "$commit_ref" >&2; return 1; }
  [[ $(git rev-parse HEAD) == "$target" ]] || {
    printf 'The checkout is not on %s; check out the release commit first.\n' "$target" >&2; return 1; }
  runtime=$(runtime_directory)
  mkdir -p "$runtime"
  exec 9>"$runtime/deploy.lock"
  flock -n 9 || { printf '%s\n' 'Another deployment holds the lock.' >&2; return 1; }
  [[ $existing == true || ! -f $runtime/current.json ]] || {
    printf 'current.json exists in %s: this checkout already has an installation; use deploy.sh.\n' "$runtime" >&2
    return 1
  }
  export TASKINDEX_IMAGE="taskindex:$target" TASKINDEX_BUILD="$target"
  TASKINDEX_DEPLOYMENT="${target:0:12}-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
  export TASKINDEX_DEPLOYMENT
  export TASKINDEX_OPEN_BOUNDARY_FILE="$runtime/opening-$TASKINDEX_DEPLOYMENT"
  export TASKINDEX_REPO="$repo" TASKINDEX_RUNTIME_DIR="$runtime"
  unset TASKINDEX_RELEASE_DIR TASKINDEX_COMPOSE_FILE
  dc config --quiet
  [[ -z $(dc ps -q app) ]] || { printf '%s\n' 'An app container is running: use deploy.sh.' >&2; return 1; }
  if [[ $build_here == true ]]; then
    printf '%s\n' 'WARNING: --build-here builds on this host; the release gate (CI check) is bypassed.' >&2
    dc_build
    resolve_image "$target"
  else
    resolve_image "$target" "$image"
  fi
  if [[ $existing != true ]] && dc run --rm --no-deps -T app test -e /data/taskindex.db </dev/null; then
    printf 'Volume %s already holds /data/taskindex.db; pass --existing-database or use another volume.\n' \
      "${TASKINDEX_VOLUME:-taskindex_data}" >&2
    return 1
  fi
  local owner_password=''
  IFS= read -r owner_password || true
  [[ -n $owner_password ]] || { printf '%s\n' 'Owner password is expected on stdin.' >&2; return 1; }
  failed() {
    local code=$?
    trap - ERR
    dc stop -t 20 app litestream 2>/dev/null || true
    printf 'Installation failed (deployment %s). Services stopped; runtime state kept in %s for diagnosis.\n' \
      "$TASKINDEX_DEPLOYMENT" "$runtime" >&2
    exit "$code"
  }
  trap failed ERR
  dc run --rm --no-deps -T app taskindex-admin migrate </dev/null >&2
  local owner_args=(--email "$owner_email")
  [[ -z $owner_name ]] || owner_args+=(--name "$owner_name")
  printf '%s\n' "$owner_password" | dc run --rm --no-deps -T app taskindex-admin create-owner "${owner_args[@]}" >&2
  owner_password=''
  if [[ -n $agent_id ]]; then
    dc run --rm --no-deps -T app taskindex-admin agent create --id "$agent_id" --label "$agent_label" \
      </dev/null >&2
    dc run --rm --no-deps -T app taskindex-admin agent-key create --agent "$agent_id" --scope "$agent_scope" \
      --out "$key_out" </dev/null >&2
  fi
  local release expected_schema writes=held
  release=$(snapshot_release "$TASKINDEX_DEPLOYMENT" "$repo/deploy" bootstrap)
  export TASKINDEX_RELEASE_DIR="$release" TASKINDEX_COMPOSE_FILE="$release/compose.yml"
  save_current_release candidate
  dc up -d app litestream
  expected_schema=$(dc run --rm --no-deps -T app node deploy/database.mjs inspect </dev/null | jq -er '.schemaVersion')
  wait_health held "$target" "$expected_schema"
  confirmed_sync >/dev/null
  if [[ $open_writes == true ]]; then
    printf '%s\n' "$TASKINDEX_DEPLOYMENT" > "$TASKINDEX_OPEN_BOUNDARY_FILE"
    dc exec -T app taskindex-admin open-writes >&2
    wait_health open "$target" "$expected_schema"
    save_current_release open
    writes=open
  fi
  trap - ERR
  jq -n --arg deployment "$TASKINDEX_DEPLOYMENT" --arg release "$release" --arg writes "$writes" \
    --arg image "$TASKINDEX_IMAGE" --arg imageId "$(image_id "$TASKINDEX_IMAGE")" \
    --arg open "op run --env-file=... -- bash deploy/compose.sh exec -T app taskindex-admin open-writes" \
    '{ok:true,deployment:$deployment,image:$image,imageId:$imageId,release:$release,writes:$writes,
      next:(["nginx: install deploy/nginx/taskindex.conf with the real domain, certbot, nginx -t, reload",
             "verify: curl -s http://127.0.0.1:3100/health (ok, build, dbWritable) and the checks in deploy/README.md"]
            + (if $writes == "held" then [("open writes: " + $open + ", then re-check /health writes:open")]
               else ["writes are open: test password login and passkey on the phone"] end)
            + ["next releases: deploy/deploy.sh --image REF COMMIT (state now lives in deploy/.runtime)"])}'
}
main "$@"
