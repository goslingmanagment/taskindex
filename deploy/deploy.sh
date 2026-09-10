#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Updates an existing installation. Bootstrap and recovery are explicit in README.
# main is parsed before git checkout changes files in this checkout.
main() {
  if [[ ${1:-} == --help || $# != 1 ]]; then
    printf '%s\n' 'Usage: op run --env-file=/protected/taskindex.env -- ./deploy/deploy.sh COMMIT' \
      'Requires an existing healthy installation. See deploy/README.md for bootstrap and recovery.'
    return 0
  fi
  local repo target runtime previous_image previous_build previous_deployment previous_health
  repo=$(git rev-parse --show-toplevel)
  cd "$repo"
  source "$repo/deploy/common.sh"
  for command in docker git curl jq flock; do command -v "$command" >/dev/null || { printf 'Missing command: %s\n' "$command" >&2; return 1; }; done
  [[ $(uname -s) == Linux ]] || { printf '%s\n' 'Run deployments on the Linux VPS. Local Docker validation uses compose directly.' >&2; return 1; }
  git diff --quiet && git diff --cached --quiet || { printf '%s\n' 'Checkout contains changes; deployment stopped.' >&2; return 1; }
  target=$(git rev-parse --verify "$1^{commit}")
  [[ $target =~ ^[a-f0-9]{40}$ ]] || return 1
  runtime=$(runtime_directory)
  mkdir -p "$runtime"
  exec 9>"$runtime/deploy.lock"
  flock -n 9 || { printf '%s\n' 'Another deployment holds the lock.' >&2; return 1; }

  load_current_release
  dc config --quiet
  local previous_container
  previous_container=$(dc ps -q app)
  [[ -n $previous_container ]] || { printf '%s\n' 'No running app. Use the initial installation procedure in deploy/README.md.' >&2; return 1; }
  previous_image=$(docker inspect --format '{{.Config.Image}}' "$previous_container")
  previous_deployment=$(docker inspect "$previous_container" | jq -er '.[0].Config.Env[] | select(startswith("TASKINDEX_DEPLOYMENT=")) | sub("^TASKINDEX_DEPLOYMENT="; "")')
  previous_health=$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3100/health)
  jq -e '.ok == true and .writes == "open"' <<<"$previous_health" >/dev/null
  previous_build=$(jq -er '.build' <<<"$previous_health")
  export TASKINDEX_IMAGE="taskindex:$target" TASKINDEX_BUILD="$target"
  export TASKINDEX_DEPLOYMENT="${target:0:12}-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
  export TASKINDEX_OPEN_BOUNDARY_FILE="$runtime/opening-$TASKINDEX_DEPLOYMENT"
  git checkout --detach "$target"
  dc build app

  local phase=before-stop backup_path opened=0 replica metadata
  backup_path="/data/backups/$(date -u +%Y%m%dT%H%M%SZ)-${target:0:12}.db"
  on_failure() {
    local code=$?
    trap - ERR
    if [[ $opened == 1 ]]; then
      printf '%s\n' 'The release may have accepted writes. Automatic database rollback is forbidden; diagnose and fix forward or obtain an explicit recovery decision.' >&2
    elif [[ $phase == migration || $phase == candidate ]]; then
      if TASKINDEX_ROLLBACK_AUTHORIZATION=pre-open-writes bash "$repo/deploy/rollback.sh" "$runtime/last-backup.json"; then
        printf '%s\n' 'The candidate failed; the previous image and closed-write checkpoint were restored and verified. Release deployment still failed.' >&2
      else
        printf '%s\n' "Automatic rollback failed. Backup retained at $backup_path; matching image $previous_image. Follow deploy/README.md Recovery." >&2
      fi
    elif [[ $phase == stopped ]]; then
      TASKINDEX_IMAGE="$previous_image" TASKINDEX_BUILD="$previous_build" TASKINDEX_DEPLOYMENT="$previous_deployment" dc up -d litestream app || true
      printf '%s\n' 'Deployment stopped before migration; attempted to restart the unchanged previous release. Verify its /health.' >&2
    fi
    exit "$code"
  }
  trap on_failure ERR
  phase=stopped
  dc stop -t 20 app
  # A SIGKILL/OOM timeout is not a successful bounded drain.
  [[ $(docker inspect --format '{{.State.ExitCode}}' "$previous_container") == 0 ]]
  replica=$(confirmed_sync)
  dc stop -t 40 litestream
  metadata=$(TASKINDEX_IMAGE="$previous_image" dc run --rm --no-deps app node deploy/database.mjs backup "$backup_path")
  jq -n --arg image "$previous_image" --arg build "$previous_build" --arg deployment "$previous_deployment" --arg backup "$backup_path" \
    --arg replicaUrl "$LITESTREAM_REPLICA_URL" --argjson database "$metadata" --argjson replication "$replica" \
    '{image:$image,build:$build,deployment:$deployment,backup:$backup,replicaUrl:$replicaUrl,database:$database,replication:$replication}' > "$runtime/last-backup.json"
  # Keep an independent manifest next to the backup, inside the persistent volume.
  dc run --rm --no-deps -T app sh -c 'cat > "$1"' sh "${backup_path%.db}.json" < "$runtime/last-backup.json"
  phase=migration
  dc run --rm --no-deps app taskindex-admin migrate
  if [[ ${TASKINDEX_FAIL_AT:-} == after-migrate ]]; then printf '%s\n' 'Injected failure after migration' >&2; false; fi
  phase=candidate
  save_current_release candidate
  dc up -d litestream app
  local health ready=0 expected_schema
  expected_schema=$(dc run --rm --no-deps -T app node deploy/database.mjs inspect | jq -er '.schemaVersion')
  for ((attempt=0; attempt<30; attempt++)); do
    if health=$(curl --fail --silent --max-time 2 http://127.0.0.1:3100/health) && \
      jq -e --arg build "$target" --argjson schema "$expected_schema" '.ok == true and .writes == "held" and .build == $build and .schemaVersion == $schema and .dbWritable == true' <<<"$health" >/dev/null; then ready=1; break; fi
    sleep 1
  done
  [[ $ready == 1 ]]
  if [[ ${TASKINDEX_FAIL_AT:-} == health ]]; then printf '%s\n' 'Injected candidate health failure' >&2; false; fi
  # Confirm the migrated, held database is replicated before public writes open.
  replica=$(confirmed_sync)
  # Mark the irreversible boundary BEFORE invocation: even a lost CLI response
  # must not cause a rollback after open-writes may have committed.
  opened=1
  save_current_release opening
  printf '%s\n' "$TASKINDEX_DEPLOYMENT" > "$TASKINDEX_OPEN_BOUNDARY_FILE"
  dc exec -T app taskindex-admin open-writes
  health=$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3100/health)
  jq -e --arg build "$target" '.ok == true and .writes == "open" and .build == $build' <<<"$health" >/dev/null
  save_current_release open
  trap - ERR
  printf '%s\n' "$health"
}
main "$@"
