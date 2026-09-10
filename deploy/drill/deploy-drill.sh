#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

# Harness of the real deploy/deploy.sh (TI-017). A throwaway git repository with three release
# commits (A: bootstrap; B: compose.yml gains TASKINDEX_RELEASE_MARKER=B; C: marker C) is built
# from this checkout, images are built like CI does (label org.opencontainers.image.revision),
# release A is installed with deploy/bootstrap.sh, then deploy.sh runs for every row of the
# matrix with TASKINDEX_FAIL_AT injections. Nothing but the real entrypoints is executed; the
# harness only observes containers, current.json, the checkout and the data.
# Linux with Docker is required by deploy.sh; on macOS the harness re-runs itself inside a Linux
# container (deploy/drill/Dockerfile.tools) with the host docker.sock and the stand mounted at the
# same absolute path, so compose bind mounts and build contexts resolve on the host daemon.
usage() {
  printf '%s\n' 'Usage: bash deploy/drill/deploy-drill.sh [--only ROW[,ROW...]] [--stand-root DIR]' \
    '  rows: guard image-missing image-label lock-held plan before-stop after-migrate health deploy after-open' \
    '  --stand-root DIR  where the throwaway repository lives (default /tmp/taskindex-deploy-drill)' \
    'Prints a JSON matrix; every row must be ok. Volumes and images are kept; the cleanup command is printed.'
}
in_container=false only='' stand_root=${TASKINDEX_DRILL_DIR:-/tmp/taskindex-deploy-drill}
while (($#)); do
  case $1 in
    --help) usage; exit 0 ;;
    --in-container) in_container=true; shift ;;
    --only) only=${2:?}; shift 2 ;;
    --stand-root) stand_root=${2:?}; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done
source_repo=$(git rev-parse --show-toplevel)
mkdir -p "$stand_root"
stand_root=$(cd "$stand_root" && pwd -P)
if [[ $(uname -s) == Darwin ]]; then
  [[ $in_container != true ]] || { printf '%s\n' '--in-container is internal.' >&2; exit 1; }
  common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
  tools_image=taskindex-drill-tools:local
  docker build --quiet -t "$tools_image" -f "$source_repo/deploy/drill/Dockerfile.tools" \
    "$source_repo/deploy/drill" >/dev/null
  args=(--in-container --stand-root "$stand_root")
  [[ -z $only ]] || args+=(--only "$only")
  exec docker run --rm -e HOME=/root -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$source_repo:$source_repo:ro" -v "$common_dir:$common_dir:ro" -v "$stand_root:$stand_root" \
    -w "$source_repo" "$tools_image" \
    bash -c 'git config --global --add safe.directory "*" && exec bash deploy/drill/deploy-drill.sh "$@"' \
    bash "${args[@]}"
fi
[[ $(uname -s) == Linux ]] || { printf '%s\n' 'deploy.sh requires Linux.' >&2; exit 1; }
for tool in docker git jq curl flock; do
  command -v "$tool" >/dev/null || { printf 'Missing: %s\n' "$tool" >&2; exit 1; }
done
run_id="$(date -u +%Y%m%d%H%M%S)-$RANDOM"
run_dir="$stand_root/run-$run_id"
stand="$run_dir/stand"
project="taskindex-drill-$run_id"
mkdir -p "$stand" "$run_dir/rows"
printf 'stand: %s\nproject: %s\n' "$stand" "$project" >&2

# --- throwaway repository: tracked and untracked (not ignored) files of this checkout -----------
while IFS= read -r -d '' file; do
  [[ -f $source_repo/$file ]] || continue
  mkdir -p "$stand/$(dirname "$file")"
  cp "$source_repo/$file" "$stand/$file"
done < <(git -C "$source_repo" ls-files -z --cached --others --exclude-standard)
git_stand() { git -C "$stand" -c user.name=drill -c user.email=drill@example.test "$@"; }
git_stand init -q -b main
git_stand add -A
git_stand commit -q -m 'release A'
A=$(git_stand rev-parse HEAD)
add_marker() {
  sed -i "s|^      TASKINDEX_WRITES: held$|      TASKINDEX_RELEASE_MARKER: $1\n      TASKINDEX_WRITES: held|" \
    "$stand/deploy/compose.yml"
  grep -q "TASKINDEX_RELEASE_MARKER: $1" "$stand/deploy/compose.yml"
  git_stand commit -q -am "release $1"
  git_stand rev-parse HEAD
}
B=$(add_marker B)
C=$(sed -i 's/TASKINDEX_RELEASE_MARKER: B/TASKINDEX_RELEASE_MARKER: C/' "$stand/deploy/compose.yml" && \
  git_stand commit -q -am 'release C' && git_stand rev-parse HEAD)
git_stand checkout -q -B running "$A"
printf 'commits: A=%s B=%s C=%s\n' "${A:0:12}" "${B:0:12}" "${C:0:12}" >&2

# --- images like CI: label = commit -------------------------------------------------------------
build_image() {
  git_stand checkout -q --detach "$1"
  docker build --build-arg "BUILD=$1" --label "org.opencontainers.image.revision=$1" -t "taskindex:$1" \
    -f "$stand/deploy/Dockerfile" "$stand" > "$run_dir/build-${1:0:12}.log" 2>&1 || {
    tail -n 40 "$run_dir/build-${1:0:12}.log" >&2; return 1; }
  git_stand checkout -q running
}
build_image "$A"
build_image "$B"
build_image "$C"
docker save "taskindex:$B" | gzip -1 > "$run_dir/image-B.tar.gz"
docker rmi "taskindex:$B" >/dev/null

# --- isolated compose project -------------------------------------------------------------------
export TASKINDEX_VOLUME="${project}_data" TASKINDEX_COMPOSE_PROJECT="$project"
export TASKINDEX_COMPOSE_OVERRIDE="$stand/deploy/compose.local.yml" TASKINDEX_DEPLOY_DIR="$stand/deploy"
export BASE_URL=http://localhost:3000
export BETTER_AUTH_SECRET=deploy-drill-secret-not-a-production-credential-123456789
export AWS_ACCESS_KEY_ID=deploy-drill AWS_SECRET_ACCESS_KEY=deploy-drill
export LITESTREAM_REPLICA_URL="file:///data/test-replica/$project"
export LITESTREAM_HEARTBEAT_URL=http://heartbeat:8787/ping
runtime="$stand/deploy/.runtime"
repo=$stand
source "$stand/deploy/common.sh"
with_release() ( load_current_release; "$@"; )
harness_failed() {
  local code=$?
  trap - ERR
  with_release dc stop -t 20 app litestream heartbeat >/dev/null 2>&1 || true
  printf 'Harness failed (code %s); kept project=%s stand=%s\n' "$code" "$project" "$run_dir" >&2
  exit "$code"
}
trap harness_failed ERR
drill() { dc run --rm --no-deps -T -v "$stand/deploy/drill:/drill:ro" app node "/drill/$1" "${@:2}"; }

# --- release A via bootstrap.sh -----------------------------------------------------------------
# deploy.sh and bootstrap.sh resolve the repository from the working directory, like on the VPS.
printf '%s\n' 'deploy-drill-password-only' | (cd "$stand" && bash deploy/bootstrap.sh --image "taskindex:$A" \
  --owner-email owner@example.test --agent drill-agent --label 'Deploy drill' --scope write \
  --out /data/drill-key.json --open-writes) > "$run_dir/bootstrap.json"
jq -e '.ok == true and .writes == "open"' "$run_dir/bootstrap.json" >/dev/null
release_a=$(jq -r '.release' "$run_dir/bootstrap.json")
with_release dc up -d heartbeat
with_release drill agent-create.mjs drill-task-1 'Задача релиза A'

# --- observations ------------------------------------------------------------------------------
running_container() { with_release dc ps -q app; }
running_image() { docker inspect --format '{{.Config.Image}}' "$(running_container)"; }
running_marker() {
  docker inspect "$(running_container)" | \
    jq -r '.[0].Config.Env[] | select(startswith("TASKINDEX_RELEASE_MARKER=")) | sub("^[^=]*="; "")'
}
health() { with_release dc exec -T app node deploy/health.mjs --print; }
task_count() { with_release dc run --rm --no-deps -T app taskindex-admin export | jq '.tasks | length'; }
backup_count() { with_release dc run --rm --no-deps -T app sh -c 'ls /data/backups/*.db 2>/dev/null | wc -l'; }
head_commit() { git_stand rev-parse HEAD; }
head_ref() { git_stand symbolic-ref -q --short HEAD || printf 'detached'; }
lock_free() { flock -n "$runtime/deploy.lock" true; }
current() { jq -r "$1" "$runtime/current.json"; }
run_deploy() {
  # run_deploy ROW [ENV=VALUE ...] -- ARGS: real deploy.sh, exit code kept, output captured.
  local row=$1 vars=() code=0; shift
  while [[ $# -gt 0 && $1 != -- ]]; do vars+=("$1"); shift; done
  shift
  (cd "$stand" && env "${vars[@]}" bash deploy/deploy.sh "$@") \
    > "$run_dir/rows/$row.stdout" 2> "$run_dir/rows/$row.stderr" || code=$?
  printf '%s' "$code"
}
rows='[]'
record() {
  # record ROW EXIT CHECK=BOOL ...: one matrix row; ok only when every check holds.
  local row=$1 code=$2 checks='{}' pair
  shift 2
  for pair in "$@"; do
    checks=$(jq --arg k "${pair%%=*}" --argjson v "${pair#*=}" '. + {($k): $v}' <<<"$checks")
  done
  rows=$(jq --arg row "$row" --argjson exit "$code" --argjson checks "$checks" \
    '. + [{row:$row,exit:$exit,ok:($checks | all),checks:$checks}]' <<<"$rows")
  jq -c '.[-1]' <<<"$rows" >&2
}
b() { if "$@"; then printf 'true'; else printf 'false'; fi; }
eq() { [[ $1 == "$2" ]]; }
wants() { [[ -z $only || ,$only, == *,$1,* ]]; }
contains() { grep -q -- "$2" "$run_dir/rows/$1.stderr"; }

container_a=$(running_container)
tasks_before=$(task_count)
backups_before=$(backup_count)
generation_a=$(health | jq -r '.generation')

if wants guard; then
  code=$(run_deploy guard TASKINDEX_FAIL_AT=health TASKINDEX_COMPOSE_PROJECT= -- --image "taskindex:$A" "$B")
  record guard "$code" "nonzero=$(b [ "$code" != 0 ])" "refused=$(b contains guard 'only allowed inside')" \
    "untouched=$(b eq "$(running_container)" "$container_a")" "lock=$(b lock_free)"
fi
if wants image-missing; then
  code=$(run_deploy image-missing -- "$B")
  record image-missing "$code" "nonzero=$(b [ "$code" != 0 ])" \
    "refused=$(b contains image-missing 'is not present')" "untouched=$(b eq "$(running_container)" "$container_a")" \
    "checkout=$(b eq "$(head_ref)" running)"
fi
if wants image-label; then
  docker tag "taskindex:$A" taskindex:drill-wrong-label
  code=$(run_deploy image-label -- --image taskindex:drill-wrong-label "$B")
  docker rmi taskindex:drill-wrong-label >/dev/null
  record image-label "$code" "nonzero=$(b [ "$code" != 0 ])" \
    "refused=$(b contains image-label 'revision label')" "untouched=$(b eq "$(running_container)" "$container_a")" \
    "checkout=$(b eq "$(head_ref)" running)"
fi
if wants lock-held; then
  # The holder keeps fd 9 to itself: sleep must not inherit the lock, and kill must release it.
  ( exec 9>"$runtime/deploy.lock"; flock 9; sleep 60 9>&- & child=$!
    trap 'kill "$child" 2>/dev/null; exit 0' TERM; wait "$child" ) &
  holder=$!
  sleep 1
  code=$(run_deploy lock-held -- --image "taskindex:$A" "$B")
  kill "$holder" 2>/dev/null || true
  wait "$holder" 2>/dev/null || true
  lock_free || { printf '%s\n' 'lock-held: the test holder did not release the lock' >&2; exit 1; }
  record lock-held "$code" "nonzero=$(b [ "$code" != 0 ])" "refused=$(b contains lock-held 'holds the lock')" \
    "untouched=$(b eq "$(running_container)" "$container_a")"
fi
if wants plan; then
  code=$(run_deploy plan -- --plan --image "$run_dir/image-B.tar.gz" "$B")
  plan=$(cat "$run_dir/rows/plan.stdout")
  code_nodocker=$(run_deploy plan-nodocker DOCKER_HOST=unix:///nonexistent -- --plan "$B")
  plan_nodocker=$(cat "$run_dir/rows/plan-nodocker.stdout")
  record plan "$code" "zero=$(b [ "$code" == 0 ])" \
    "target=$(b eq "$(jq -r '.target' <<<"$plan")" "$B")" \
    "docker=$(b eq "$(jq -r '.docker.available' <<<"$plan")" true)" \
    "runningDeployment=$(b eq "$(jq -r '.docker.runningDeployment' <<<"$plan")" "$(current '.deployment')")" \
    "archive=$(b eq "$(jq -r '.image.present' <<<"$plan")" archive)" \
    "currentOpen=$(b eq "$(jq -r '.current.status' <<<"$plan")" open)" \
    "willChangeCheckout=$(b eq "$(jq -r '.willChangeCheckout' <<<"$plan")" true)" \
    "untouched=$(b eq "$(running_container)" "$container_a")" "checkout=$(b eq "$(head_ref)" running)" \
    "noDockerZero=$(b [ "$code_nodocker" == 0 ])" \
    "noDockerUnavailable=$(b eq "$(jq -r '.docker' <<<"$plan_nodocker")" unavailable)"
fi
failed_before_open() {
  # Rows before-stop / after-migrate / health: release A runs again with its own configuration.
  local row=$1 code=$2 expect_backup=$3
  record "$row" "$code" "nonzero=$(b [ "$code" != 0 ])" \
    "imageA=$(b eq "$(running_image)" "taskindex:$A")" "noMarker=$(b eq "$(running_marker)" '')" \
    "writesOpen=$(b eq "$(health | jq -r '.writes')" open)" "statusOpen=$(b eq "$(current '.status')" open)" \
    "currentImageA=$(b eq "$(current '.image')" "taskindex:$A")" \
    "releaseA=$(b eq "$(current '.release')" "$release_a")" \
    "tasksKept=$(b eq "$(task_count)" "$tasks_before")" "checkoutA=$(b eq "$(head_commit)" "$A")" \
    "onBranch=$(b eq "$(head_ref)" running)" "lock=$(b lock_free)" "$expect_backup"
}
if wants before-stop; then
  code=$(run_deploy before-stop TASKINDEX_FAIL_AT=before-stop -- --image "$run_dir/image-B.tar.gz" "$B")
  failed_before_open before-stop "$code" "noNewBackup=$(b eq "$(backup_count)" "$backups_before")"
  # The archive was loaded by that run; the next rows use the tag like a VPS after docker load.
  docker image inspect "taskindex:$B" >/dev/null
fi
if wants after-migrate; then
  code=$(run_deploy after-migrate TASKINDEX_FAIL_AT=after-migrate -- --image "taskindex:$B" "$B")
  failed_before_open after-migrate "$code" "restored=$(b eq "$(current '.replicaUrl | contains("-restore-")')" true)"
  rows=$(jq --arg g "$generation_a" --arg now "$(health | jq -r '.generation')" \
    '.[-1].checks.newGeneration = ($g != $now) | .[-1].ok = (.[-1].checks | all)' <<<"$rows")
  generation_a=$(health | jq -r '.generation')
fi
if wants health; then
  code=$(run_deploy health TASKINDEX_FAIL_AT=health -- --image "taskindex:$B" "$B")
  failed_before_open health "$code" "restored=$(b eq "$(current '.replicaUrl | contains("-restore-")')" true)"
  rows=$(jq --arg g "$generation_a" --arg now "$(health | jq -r '.generation')" \
    '.[-1].checks.newGeneration = ($g != $now) | .[-1].ok = (.[-1].checks | all)' <<<"$rows")
fi
if wants deploy; then
  code=$(run_deploy deploy -- --image "taskindex:$B" "$B")
  release_b=$(current '.release')
  record deploy "$code" "zero=$(b [ "$code" == 0 ])" "imageB=$(b eq "$(running_image)" "taskindex:$B")" \
    "markerB=$(b eq "$(running_marker)" B)" "writesOpen=$(b eq "$(health | jq -r '.writes')" open)" \
    "buildB=$(b eq "$(health | jq -r '.build')" "$B")" "statusOpen=$(b eq "$(current '.status')" open)" \
    "releaseDir=$(b [ -d "$release_b" ])" "releaseFiles=$(b eq "$(ls "$release_b" | wc -l | tr -d ' ')" 5)" \
    "releaseSha=$(b verify_release_snapshot "$release_b")" \
    "releaseCommit=$(b eq "$(jq -r '.commit' "$release_b/release.json")" "$B")" \
    "tasksKept=$(b eq "$(task_count)" "$tasks_before")" "checkoutB=$(b eq "$(head_commit)" "$B")" \
    "lock=$(b lock_free)"
  with_release drill agent-create.mjs drill-task-2 'Задача релиза B'
  tasks_before=$(task_count)
fi
if wants after-open; then
  code=$(run_deploy after-open TASKINDEX_FAIL_AT=after-open -- --image "taskindex:$C" "$C")
  record after-open "$code" "nonzero=$(b [ "$code" != 0 ])" \
    "forbidden=$(b contains after-open 'Automatic database rollback is forbidden')" \
    "imageC=$(b eq "$(running_image)" "taskindex:$C")" "markerC=$(b eq "$(running_marker)" C)" \
    "writesOpen=$(b eq "$(health | jq -r '.writes')" open)" "statusOpening=$(b eq "$(current '.status')" opening)" \
    "tasksKept=$(b eq "$(task_count)" "$tasks_before")" "checkoutC=$(b eq "$(head_commit)" "$C")" \
    "lock=$(b lock_free)"
  # Fix forward: writes are open, new data is accepted; nothing rolled the database back.
  with_release drill agent-create.mjs drill-task-3 'Задача после after-open'
  rows=$(jq --argjson kept "$(b eq "$(task_count)" "$((tasks_before + 1))")" \
    '.[-1].checks.writesAccepted = $kept | .[-1].ok = (.[-1].checks | all)' <<<"$rows")
fi
with_release dc stop -t 20 app litestream heartbeat >/dev/null 2>&1 || true
cleanup="docker rm -f \$(docker ps -aq --filter label=com.docker.compose.project=$project); "
cleanup+="docker volume rm ${project}_data; docker network rm ${project}_default; "
cleanup+="docker rmi taskindex:$A taskindex:$B taskindex:$C; rm -rf $run_dir"
jq -n --arg project "$project" --arg stand "$stand" --arg cleanup "$cleanup" --argjson rows "$rows" \
  --arg a "$A" --arg b "$B" --arg c "$C" \
  '{ok:($rows | all(.ok)),project:$project,stand:$stand,commits:{A:$a,B:$b,C:$c},rows:$rows,cleanup:$cleanup}'
jq -e '.ok' <<<"$(jq -n --argjson rows "$rows" '{ok:($rows | all(.ok))}')" >/dev/null
