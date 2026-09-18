#!/usr/bin/env bash
# Source from an entrypoint that has set repo. Values here contain no secrets.
: "${repo:?common.sh requires repo}"
runtime_directory() { printf '%s\n' "${TASKINDEX_RUNTIME_DIR:-$repo/deploy/.runtime}"; }
# The compose file of the running release: its snapshot when current.json names one
# (TI-015), otherwise the checkout. Overrides and build files are added by callers.
compose_file() { printf '%s\n' "${TASKINDEX_COMPOSE_FILE:-$repo/deploy/compose.yml}"; }
load_current_release() {
  local state release
  state="$(runtime_directory)/current.json"
  if [[ -f $state ]]; then
    export TASKINDEX_IMAGE TASKINDEX_BUILD TASKINDEX_DEPLOYMENT LITESTREAM_REPLICA_URL
    TASKINDEX_IMAGE=$(jq -er '.image' "$state")
    TASKINDEX_BUILD=$(jq -er '.build' "$state")
    TASKINDEX_DEPLOYMENT=$(jq -er '.deployment' "$state")
    LITESTREAM_REPLICA_URL=$(jq -er '.replicaUrl' "$state")
    release=$(jq -r '.release // empty' "$state")
    if [[ -n $release ]]; then
      [[ -f $release/compose.yml ]] || {
        printf 'Release snapshot %s named in %s is missing; refusing to fall back to the checkout.\n' \
          "$release" "$state" >&2
        return 1
      }
      export TASKINDEX_RELEASE_DIR="$release" TASKINDEX_COMPOSE_FILE="$release/compose.yml"
    fi
  fi
}
dc() {
  local compose_args=(-f "$(compose_file)")
  if [[ -n ${TASKINDEX_COMPOSE_PROJECT:-} ]]; then
    compose_args=(-p "$TASKINDEX_COMPOSE_PROJECT" "${compose_args[@]}")
  fi
  if [[ -n ${TASKINDEX_COMPOSE_OVERRIDE:-} ]]; then compose_args+=(-f "$TASKINDEX_COMPOSE_OVERRIDE"); fi
  docker compose "${compose_args[@]}" "$@"
}
# The build override lives next to the checkout, never inside a release snapshot.
dc_build() { dc -f "$repo/deploy/compose.build.yml" build app; }
image_id() { docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || printf 'null'; }
image_revision() {
  docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2>/dev/null
}
# save_current_release STATUS: image/build/deployment/replicaUrl from the environment,
# release directory from TASKINDEX_RELEASE_DIR, imageId from the daemon.
save_current_release() {
  local state_dir temporary
  state_dir=$(runtime_directory)
  mkdir -p "$state_dir"
  temporary="$state_dir/current.json.$$"
  jq -n --arg image "$TASKINDEX_IMAGE" --arg build "$TASKINDEX_BUILD" \
    --arg deployment "$TASKINDEX_DEPLOYMENT" --arg replicaUrl "$LITESTREAM_REPLICA_URL" \
    --arg status "$1" --arg release "${TASKINDEX_RELEASE_DIR:-}" \
    --arg imageId "$(image_id "$TASKINDEX_IMAGE")" \
    '{image:$image,build:$build,deployment:$deployment,replicaUrl:$replicaUrl,status:$status,
      release:(if $release == "" then null else $release end),
      imageId:(if $imageId == "null" then null else $imageId end)}' > "$temporary"
  mv "$temporary" "$state_dir/current.json"
}
# prune_superseded_images KEEP_REF...: remove commit-tagged images (taskindex:<40 hex>) that are
# neither a KEEP_REF (the new release and the previous one, which is its rollback) nor the image
# of a running container. Every release loads one more ~1 GB image and nothing removed them: on
# 2026-09-18 twenty of them shared the VPS disk with Agency Hub and helped push it over 90 %.
# Never inside an isolated compose project (a drill shares the daemon with a developer's own
# tags). Best effort: a failure is reported and never fails the release.
prune_superseded_images() {
  if [[ -n ${TASKINDEX_COMPOSE_PROJECT:-} ]]; then
    printf '%s\n' 'Image prune skipped inside an isolated compose project.' >&2
    return 0
  fi
  local ref id tag removed=0
  declare -A keep=()
  for ref in "$@"; do
    id=$(image_id "$ref")
    [[ $id == null ]] || keep["$id"]=1
  done
  while IFS= read -r id; do
    [[ -z $id ]] || keep["$id"]=1
  done < <(docker ps -q 2>/dev/null | xargs -r docker inspect --format '{{.Image}}' 2>/dev/null)
  ((${#keep[@]} >= 1)) || { printf '%s\n' 'Image prune skipped: no protected image resolved.' >&2; return 0; }
  while IFS= read -r tag; do
    [[ $tag =~ ^taskindex:[a-f0-9]{40}$ ]] || continue
    id=$(image_id "$tag")
    [[ $id != null && -z ${keep[$id]:-} ]] || continue
    if docker rmi "$tag" >/dev/null 2>&1; then removed=$((removed + 1))
    else printf 'Could not remove image %s; left in place.\n' "$tag" >&2; fi
  done < <(docker images --format '{{.Repository}}:{{.Tag}}' taskindex 2>/dev/null)
  printf 'Image prune: removed %s superseded taskindex image tag(s).\n' "$removed" >&2
  docker builder prune --force --filter until=168h >/dev/null 2>&1 \
    || printf '%s\n' 'Builder cache prune failed; continuing.' >&2
}
file_sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
release_files=(compose.yml litestream.yml common.sh rollback.sh)
# snapshot_release DEPLOYMENT SOURCE_DIR SOURCE_LABEL: copy the release configuration
# into <runtime>/releases/DEPLOYMENT/ with release.json (sha256 per file). Prints the
# directory. Refuses to overwrite: a deployment id names exactly one snapshot.
snapshot_release() {
  local deployment=$1 source_dir=$2 source_label=$3 target files commit name
  target="$(runtime_directory)/releases/$deployment"
  [[ ! -e $target ]] || { printf 'Release snapshot already exists: %s\n' "$target" >&2; return 1; }
  mkdir -p "$target"
  files='{}'
  for name in "${release_files[@]}"; do
    [[ -f $source_dir/$name ]] || { printf 'Missing release file: %s/%s\n' "$source_dir" "$name" >&2; return 1; }
    cp "$source_dir/$name" "$target/$name"
    # Snapshots are written under umask 077, but litestream.yml is bind-mounted into a
    # container running as uid 1000 (real Linux honours the mode; Docker Desktop hid this).
    [[ $name != litestream.yml ]] || chmod 644 "$target/$name"
    files=$(jq --arg name "$name" --arg sha "$(file_sha256 "$target/$name")" '. + {($name): $sha}' <<<"$files")
  done
  commit=$(git -C "$source_dir" rev-parse HEAD 2>/dev/null || printf 'unknown')
  jq -n --arg deployment "$deployment" --arg commit "$commit" --arg image "${TASKINDEX_IMAGE:-}" \
    --arg imageId "$(image_id "${TASKINDEX_IMAGE:-}")" --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg source "$source_label" --argjson files "$files" \
    '{deployment:$deployment,commit:$commit,image:$image,
      imageId:(if $imageId == "null" then null else $imageId end),
      createdAt:$createdAt,source:$source,files:$files}' > "$target/release.json"
  printf '%s\n' "$target"
}
# verify_release_snapshot DIR: every file listed in release.json is present and unchanged.
verify_release_snapshot() {
  local dir=$1 name expected actual
  [[ -f $dir/release.json ]] || { printf 'No release.json in %s\n' "$dir" >&2; return 1; }
  for name in "${release_files[@]}"; do
    expected=$(jq -er --arg name "$name" '.files[$name]' "$dir/release.json") || {
      printf 'release.json in %s does not list %s\n' "$dir" "$name" >&2; return 1; }
    [[ -f $dir/$name ]] || { printf 'Release snapshot %s lacks %s\n' "$dir" "$name" >&2; return 1; }
    actual=$(file_sha256 "$dir/$name")
    [[ $actual == "$expected" ]] || {
      printf 'Release file %s/%s changed since the snapshot\n' "$dir" "$name" >&2; return 1; }
  done
}
# resolve_image TARGET [REF|TAR]: make taskindex:TARGET available locally from a transferred
# archive (docker load), a registry reference (docker pull) or a local tag; refuse unless the
# image carries label org.opencontainers.image.revision=TARGET (TI-016).
resolve_image() {
  local target=$1 ref=${2:-} loaded label
  if [[ -n $ref && -f $ref ]]; then
    # Loading happens before anything is stopped, so one retry on a transient daemon error is safe.
    if ! loaded=$(docker load --quiet --input "$ref"); then
      printf 'docker load failed for %s; retrying once\n' "$ref" >&2
      sleep 3
      loaded=$(docker load --quiet --input "$ref") || { printf 'docker load failed for %s\n' "$ref" >&2; return 1; }
    fi
    ref=$(sed -n 's/^Loaded image: //p' <<<"$loaded" | head -n1)
    [[ -n $ref ]] || { printf 'Archive %s contains no tagged image\n' "$2" >&2; return 1; }
  fi
  [[ -n $ref ]] || ref="taskindex:$target"
  if ! docker image inspect "$ref" >/dev/null 2>&1; then
    if [[ $ref == */* ]]; then docker pull --quiet "$ref" >/dev/null || return 1
    else
      printf 'Image %s is not present. Transfer it (docker save | ssh docker load) and pass --image,' "$ref" >&2
      printf ' or build on this host with --build-here (emergency only).\n' >&2
      return 1
    fi
  fi
  label=$(image_revision "$ref")
  [[ $label == "$target" ]] || {
    printf 'Image %s carries revision label "%s", expected %s; refusing.\n' "$ref" "$label" "$target" >&2
    return 1
  }
  [[ $ref == "taskindex:$target" ]] || docker tag "$ref" "taskindex:$target"
}
# wait_health WRITES BUILD SCHEMA: the running app answers /health with these values
# and dbWritable:true within 30 s. The probe is deploy/health.mjs inside the image.
wait_health() {
  local writes=$1 build=$2 schema=$3
  for ((attempt=0; attempt<30; attempt++)); do
    if dc exec -T app node deploy/health.mjs \
      --expect "writes=$writes" "build=$build" "schemaVersion=$schema" dbWritable=true 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  printf 'The app did not report writes=%s build=%s schemaVersion=%s within 30 s.\n' "$writes" "$build" "$schema" >&2
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
