#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Updates an existing installation. First installation: deploy/bootstrap.sh; recovery: README.
# main is parsed before git checkout changes files in this checkout.
usage() {
  printf '%s\n' \
    'Usage: op run --env-file=/protected/taskindex.env -- bash deploy/deploy.sh [OPTIONS] COMMIT' \
    '  --image REF|ARCHIVE  image built by CI for COMMIT: a local tag, a registry reference or a' \
    '                       docker-save archive (loaded here); default taskindex:COMMIT must exist' \
    '  --build-here         emergency only: build the image on this host instead of using --image' \
    '  --plan               print the deployment plan as JSON and exit without touching anything' \
    'Requires an existing healthy installation. See deploy/README.md for bootstrap and recovery.'
}
main() {
  local image='' build_here=false plan=false target_ref=''
  while (($#)); do
    case $1 in
      --help) usage; return 0 ;;
      --image) image=${2:?--image requires a reference or an archive}; shift 2 ;;
      --build-here) build_here=true; shift ;;
      --plan) plan=true; shift ;;
      --*) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; return 1 ;;
      *) [[ -z $target_ref ]] || { usage >&2; return 1; }; target_ref=$1; shift ;;
    esac
  done
  [[ -n $target_ref ]] || { usage >&2; return 1; }
  local repo target runtime previous_ref
  repo=$(git rev-parse --show-toplevel)
  cd "$repo"
  source "$repo/deploy/common.sh"
  target=$(git rev-parse --verify --quiet "$target_ref^{commit}") || {
    printf 'Unknown commit: %s\n' "$target_ref" >&2; return 1; }
  [[ $target =~ ^[a-f0-9]{40}$ ]] || return 1
  runtime=$(runtime_directory)
  previous_ref=$(git symbolic-ref -q --short HEAD || git rev-parse HEAD)
  if [[ $plan == true ]]; then print_plan; return 0; fi
  # Fault injection is a rehearsal tool: only inside an isolated compose project (TI-017).
  [[ -z ${TASKINDEX_FAIL_AT:-} || -n ${TASKINDEX_COMPOSE_PROJECT:-} ]] || {
    printf '%s\n' 'TASKINDEX_FAIL_AT is only allowed inside an isolated TASKINDEX_COMPOSE_PROJECT.' >&2
    return 1
  }
  local tool
  for tool in docker git curl jq flock; do
    command -v "$tool" >/dev/null || { printf 'Missing command: %s\n' "$tool" >&2; return 1; }
  done
  [[ $(uname -s) == Linux ]] || {
    printf '%s\n' 'Run deployments on the Linux VPS. Local Docker validation uses deploy/local-drill.sh.' >&2
    return 1
  }
  git diff --quiet && git diff --cached --quiet || {
    printf '%s\n' 'Checkout contains changes; deployment stopped.' >&2; return 1; }
  mkdir -p "$runtime"
  exec 9>"$runtime/deploy.lock"
  flock -n 9 || { printf '%s\n' 'Another deployment holds the lock.' >&2; return 1; }

  local previous_image previous_build previous_deployment previous_health previous_container previous_release
  load_current_release
  dc config --quiet
  previous_container=$(dc ps -q app)
  [[ -n $previous_container ]] || {
    printf '%s\n' 'No running app. Use deploy/bootstrap.sh for the first installation.' >&2; return 1; }
  previous_image=$(docker inspect --format '{{.Config.Image}}' "$previous_container")
  previous_deployment=$(docker inspect "$previous_container" | \
    jq -er '.[0].Config.Env[] | select(startswith("TASKINDEX_DEPLOYMENT=")) | sub("^TASKINDEX_DEPLOYMENT="; "")')
  # The image is verified before anything is stopped: label revision must equal COMMIT.
  if [[ $build_here != true ]]; then resolve_image "$target" "$image"; fi
  # Configuration of the running release: its snapshot, or (first release after TI-015)
  # the checkout as it is before git checkout, assumed to match the running containers.
  previous_release=${TASKINDEX_RELEASE_DIR:-}
  if [[ -z $previous_release ]]; then
    previous_release="$runtime/releases/$previous_deployment"
    if [[ -d $previous_release ]]; then
      verify_release_snapshot "$previous_release"
    else
      printf 'current.json names no release snapshot; snapshotting %s/deploy as the running release %s.\n' \
        "$repo" "$previous_deployment" >&2
      TASKINDEX_IMAGE="$previous_image" snapshot_release "$previous_deployment" "$repo/deploy" \
        checkout-before-deploy >/dev/null
    fi
    export TASKINDEX_RELEASE_DIR="$previous_release" TASKINDEX_COMPOSE_FILE="$previous_release/compose.yml"
  fi
  verify_release_snapshot "$previous_release"
  export TASKINDEX_IMAGE="taskindex:$target" TASKINDEX_BUILD="$target"
  TASKINDEX_DEPLOYMENT="${target:0:12}-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
  export TASKINDEX_DEPLOYMENT
  export TASKINDEX_OPEN_BOUNDARY_FILE="$runtime/opening-$TASKINDEX_DEPLOYMENT"
  export TASKINDEX_REPO="$repo" TASKINDEX_RUNTIME_DIR="$runtime"

  local phase=before-stop backup_path opened=0 replica metadata candidate_release
  backup_path="/data/backups/$(date -u +%Y%m%dT%H%M%SZ)-${target:0:12}.db"
  restore_checkout() {
    git checkout --quiet "$previous_ref" || \
      printf 'Could not return the checkout to %s; do it manually.\n' "$previous_ref" >&2
  }
  on_failure() {
    local code=$?
    trap - ERR
    if [[ $opened == 1 ]]; then
      printf '%s\n' 'The release may have accepted writes. Automatic database rollback is forbidden;' \
        'diagnose and fix forward or obtain an explicit recovery decision. The checkout stays on the candidate.' >&2
    elif [[ $phase == migration || $phase == candidate ]]; then
      if TASKINDEX_ROLLBACK_AUTHORIZATION=pre-open-writes bash "$previous_release/rollback.sh" \
        "$runtime/last-backup.json"; then
        printf '%s\n' 'The candidate failed; the previous release (image, configuration, closed-write checkpoint)' \
          'was restored and verified. Release deployment still failed.' >&2
      else
        printf 'Automatic rollback failed. Backup retained at %s; matching image %s; configuration %s.\n' \
          "$backup_path" "$previous_image" "$previous_release" >&2
        printf '%s\n' 'Follow deploy/README.md Recovery.' >&2
      fi
      restore_checkout
    elif [[ $phase == stopped ]]; then
      TASKINDEX_IMAGE="$previous_image" TASKINDEX_BUILD="$previous_build" \
        TASKINDEX_DEPLOYMENT="$previous_deployment" TASKINDEX_RELEASE_DIR="$previous_release" \
        TASKINDEX_COMPOSE_FILE="$previous_release/compose.yml" restart_previous || true
      restore_checkout
    else
      printf '%s\n' 'Deployment stopped before touching the running release.' >&2
      restore_checkout
    fi
    exit "$code"
  }
  restart_previous() {
    dc up -d litestream app
    printf '%s\n' 'Deployment stopped before migration; restarted the unchanged previous release.' >&2
    if wait_health open "$previous_build" "$(jq -er '.database.schemaVersion' "$runtime/last-backup.json")"; then
      save_current_release open
    else
      printf '%s\n' 'The previous release did not report healthy; verify its /health manually.' >&2
    fi
  }
  inject() {
    if [[ ${TASKINDEX_FAIL_AT:-} == "$1" ]]; then printf 'Injected failure at %s\n' "$1" >&2; false; fi
  }
  git checkout --detach "$target"
  trap on_failure ERR
  if [[ $build_here == true ]]; then
    printf '%s\n' 'WARNING: --build-here builds on this host; the release gate (CI check) is bypassed.' >&2
    TASKINDEX_COMPOSE_FILE="$repo/deploy/compose.yml" dc_build
    resolve_image "$target"
  fi
  candidate_release=$(snapshot_release "$TASKINDEX_DEPLOYMENT" "$repo/deploy" checkout)
  TASKINDEX_COMPOSE_FILE="$candidate_release/compose.yml" dc config --quiet
  # The previous release is probed from the candidate image on the compose network: the
  # running image may predate deploy/health.mjs.
  previous_health=$(dc run --rm --no-deps -T app node deploy/health.mjs \
    --url http://app:3000/health --expect writes=open --print)
  previous_build=$(jq -er '.build' <<<"$previous_health")
  inject before-stop
  phase=stopped
  dc stop -t 20 app
  # A SIGKILL/OOM timeout is not a successful bounded drain.
  [[ $(docker inspect --format '{{.State.ExitCode}}' "$previous_container") == 0 ]]
  replica=$(confirmed_sync)
  dc stop -t 40 litestream
  metadata=$(TASKINDEX_IMAGE="$previous_image" dc run --rm --no-deps -T app \
    node deploy/database.mjs backup "$backup_path")
  jq -n --arg image "$previous_image" --arg build "$previous_build" --arg deployment "$previous_deployment" \
    --arg backup "$backup_path" --arg replicaUrl "$LITESTREAM_REPLICA_URL" --arg previousRelease "$previous_release" \
    --arg imageId "$(image_id "$previous_image")" --argjson database "$metadata" --argjson replication "$replica" \
    '{image:$image,imageId:$imageId,build:$build,deployment:$deployment,previousRelease:$previousRelease,
      backup:$backup,replicaUrl:$replicaUrl,database:$database,replication:$replication}' > "$runtime/last-backup.json"
  # Keep an independent manifest next to the backup, inside the persistent volume.
  dc run --rm --no-deps -T app sh -c 'cat > "$1"' sh "${backup_path%.db}.json" < "$runtime/last-backup.json"
  # From here on the candidate's configuration applies.
  export TASKINDEX_RELEASE_DIR="$candidate_release" TASKINDEX_COMPOSE_FILE="$candidate_release/compose.yml"
  phase=migration
  dc run --rm --no-deps -T app taskindex-admin migrate
  inject after-migrate
  phase=candidate
  save_current_release candidate
  dc up -d litestream app
  local health expected_schema
  expected_schema=$(dc run --rm --no-deps -T app node deploy/database.mjs inspect | jq -er '.schemaVersion')
  wait_health held "$target" "$expected_schema"
  inject health
  # Confirm the migrated, held database is replicated before public writes open.
  replica=$(confirmed_sync)
  # Mark the irreversible boundary BEFORE invocation: even a lost CLI response
  # must not cause a rollback after open-writes may have committed.
  opened=1
  save_current_release opening
  printf '%s\n' "$TASKINDEX_DEPLOYMENT" > "$TASKINDEX_OPEN_BOUNDARY_FILE"
  dc exec -T app taskindex-admin open-writes
  wait_health open "$target" "$expected_schema"
  health=$(dc exec -T app node deploy/health.mjs --expect writes=open "build=$target" --print)
  inject after-open
  save_current_release open
  trap - ERR
  printf '%s\n' "$health"
}
# --plan: a read-only description of what main would do. Nothing is created: no runtime
# directory, no lock file, no checkout change. Docker and compose are optional here.
print_plan() {
  local missing=() tool linux=false clean=false lock=free current=null docker_json image_ref image_json
  local release_dir='' warnings=() phases
  for tool in docker git curl jq flock; do command -v "$tool" >/dev/null || missing+=("$tool"); done
  [[ $(uname -s) != Linux ]] || linux=true
  if git diff --quiet && git diff --cached --quiet; then clean=true; fi
  if [[ -f $runtime/deploy.lock ]]; then
    if command -v flock >/dev/null; then
      if flock -n "$runtime/deploy.lock" true 2>/dev/null; then lock=free; else lock=held; fi
    else lock=unknown; fi
  fi
  if [[ -f $runtime/current.json ]]; then
    current=$(jq -c . "$runtime/current.json")
    if load_current_release 2>/dev/null; then release_dir=${TASKINDEX_RELEASE_DIR:-}
    else warnings+=("current.json names a release snapshot that is missing"); fi
  fi
  image_ref=${image:-taskindex:$target}
  if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    local running='' running_image=null running_deployment=null present=false label=null
    running=$(dc ps -q app 2>/dev/null || true)
    if [[ -n $running ]]; then
      running_image=$(docker inspect --format '{{.Config.Image}}' "$running" | jq -R .)
      running_deployment=$(docker inspect "$running" | \
        jq -c '.[0].Config.Env[] | select(startswith("TASKINDEX_DEPLOYMENT=")) | sub("^TASKINDEX_DEPLOYMENT="; "")')
    fi
    docker_json=$(jq -nc --argjson runningImage "$running_image" --argjson runningDeployment "$running_deployment" \
      '{available:true,runningImage:$runningImage,runningDeployment:$runningDeployment}')
    if [[ -f $image_ref ]]; then present=archive
    elif docker image inspect "$image_ref" >/dev/null 2>&1; then
      present=true; label=$(image_revision "$image_ref" | jq -R .)
    fi
    image_json=$(jq -nc --arg ref "$image_ref" --argjson present "$(jq -n --arg p "$present" \
      'if $p == "true" then true elif $p == "false" then false else $p end')" --argjson label "$label" \
      '{ref:$ref,present:$present,label:$label,buildHere:'"$build_here"'}')
  else
    docker_json='"unavailable"'
    image_json=$(jq -nc --arg ref "$image_ref" '{ref:$ref,present:"unavailable",label:null,buildHere:'"$build_here"'}')
  fi
  phases='["verify-image","snapshot-candidate-release","probe-previous-release","stop-app","confirmed-sync",'
  phases+='"stop-litestream","backup-and-manifest","migrate","start-held","wait-health-held","confirmed-sync",'
  phases+='"open-writes","wait-health-open","save-current-release"]'
  jq -n --arg repo "$repo" --arg previousRef "$previous_ref" --arg target "$target" \
    --arg deployment "${target:0:12}-$(date -u +%Y%m%dT%H%M%SZ)-<rand>" --arg runtimeDir "$runtime" \
    --arg lock "$lock" --argjson current "$current" --arg release "$release_dir" \
    --arg backupPath "/data/backups/$(date -u +%Y%m%dT%H%M%SZ)-${target:0:12}.db" \
    --argjson phases "$phases" --argjson image "$image_json" --argjson docker "$docker_json" \
    --argjson linux "$linux" --argjson checkoutClean "$clean" \
    --argjson missingTools "$(printf '%s\n' "${missing[@]}" | jq -R . | jq -sc 'map(select(length > 0))')" \
    --argjson warnings "$(printf '%s\n' "${warnings[@]}" | jq -R . | jq -sc 'map(select(length > 0))')" \
    '{repo:$repo,previousRef:$previousRef,target:$target,image:$image,deployment:$deployment,
      runtimeDir:$runtimeDir,lock:$lock,current:$current,
      previousRelease:(if $release == "" then null else $release end),
      backupPath:$backupPath,phases:$phases,willChangeCheckout:true,docker:$docker,
      preflight:{linux:$linux,checkoutClean:$checkoutClean,missingTools:$missingTools},warnings:$warnings}'
}
main "$@"
