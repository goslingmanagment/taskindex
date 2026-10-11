#!/usr/bin/env bash
# One-command release from the owner's Mac (TI-094, owner 2026-09-15: the manual ritual had
# six steps). Usage:
#
#   bash deploy/release.sh [SHA|REF] [--plan]
#
# SHA defaults to origin/main and must be merged into origin/main. Steps: the CI workflow
# run for that commit must be green (an in-progress run is awaited); the image artifact
# taskindex-image-<sha> is downloaded by the VPS itself through a short-lived signed GitHub
# URL and loaded into Docker (skipped when taskindex:<sha> is already loaded); the commit is
# pushed to the bare repository the VPS checkout fetches from; an off-site backup is pulled;
# on the VPS the checkout moves to <sha> and deploy/deploy.sh runs with the server env file,
# first --plan, then for real; then a second backup. --plan stops after the server's plan:
# no checkout change, no backup, no deploy (the image load and the bare-repo push are
# idempotent). Needs git, gh (logged in), curl and SSH access to the VPS; reads no secrets.
set -Eeuo pipefail

host=${TASKINDEX_HOST:-root@152.53.191.242}
repo_on_host=${TASKINDEX_REMOTE_REPO:-/opt/taskindex}
bare_on_host=${TASKINDEX_REMOTE_BARE:-/opt/taskindex.git}
remote_env=${TASKINDEX_REMOTE_ENV:-/etc/taskindex/taskindex.env}
workflow=${TASKINDEX_CI_WORKFLOW:-ci}

plan=false
ref=""
for arg in "$@"; do
  case $arg in
    --plan) plan=true ;;
    --help | -h) sed -n '2,16p' "$0"; exit 0 ;;
    --*) printf 'Unknown option: %s\n' "$arg" >&2; exit 1 ;;
    *) [[ -z $ref ]] || { printf 'One ref only.\n' >&2; exit 1; }; ref=$arg ;;
  esac
done

say() { printf '\n== %s\n' "$*" >&2; }
remote() { ssh -o BatchMode=yes "$host" "$@"; }

cd "$(git rev-parse --show-toplevel)"
git fetch -q origin
sha=$(git rev-parse --verify "${ref:-origin/main}^{commit}")
git merge-base --is-ancestor "$sha" origin/main \
  || { printf 'Commit %s is not on origin/main: release only what is merged.\n' "$sha" >&2; exit 1; }
say "release ${sha:0:7}: $(git log -1 --format=%s "$sha")"

say "CI ($workflow)"
run_id=$(gh run list --workflow "$workflow" --commit "$sha" --limit 1 --json databaseId --jq '.[0].databaseId')
[[ -n $run_id ]] || { printf 'No %s run for %s yet: push first or wait for GitHub.\n' "$workflow" "$sha" >&2; exit 1; }
state=$(gh run view "$run_id" --json status,conclusion --jq '.status + "/" + .conclusion')
if [[ $state != completed/success ]]; then
  say "waiting for run $run_id ($state)"
  gh run watch "$run_id" --exit-status >&2 || { printf 'CI run %s is not green.\n' "$run_id" >&2; exit 1; }
fi
printf 'run %s green\n' "$run_id" >&2

image="taskindex:$sha"
say "image $image"
if remote "docker image inspect '$image' >/dev/null 2>&1"; then
  printf 'already loaded on %s\n' "$host" >&2
else
  # The artifact lives 7 days (ci.yml) and a rebuilt one can sit next to an expired copy:
  # take the newest unexpired one explicitly, not whatever the API lists last.
  artifact_id=$(gh api "repos/{owner}/{repo}/actions/runs/$run_id/artifacts?per_page=100" \
    --jq "[.artifacts[] | select(.name == \"taskindex-image-$sha\" and (.expired | not))]
      | max_by(.created_at) | .id // empty")
  [[ -n $artifact_id ]] || {
    # Rebuild only the image job: re-running the whole run would repeat check and e2e.
    image_job=$(gh run view "$run_id" --json jobs --jq '.jobs[] | select(.name == "image") | .databaseId') \
      || image_job=''
    printf 'Artifact taskindex-image-%s missing or expired in run %s: rebuild it with gh run rerun %s --job %s\n' \
      "$sha" "$run_id" "$run_id" "${image_job:-<image job id>}" >&2
    exit 1
  }
  slug=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
  # A HEAD request answers 302 with a short-lived signed URL; the VPS downloads it directly,
  # which is much faster than pulling 150 MB to the Mac and pushing it back over SSH.
  url=$(curl -fsSI -H "Authorization: Bearer $(gh auth token)" -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$slug/actions/artifacts/$artifact_id/zip" \
    | awk 'tolower($1) == "location:" { print $2 }' | tr -d '\r')
  [[ $url == https://* ]] || { printf 'No signed artifact URL for artifact %s.\n' "$artifact_id" >&2; exit 1; }
  remote "sha='$sha' url='$url' bash -s" <<'REMOTE'
set -Eeuo pipefail
dir="/var/tmp/taskindex-release-$sha"
trap 'rm -rf "$dir"' EXIT
rm -rf "$dir" && mkdir -p "$dir" && cd "$dir"
curl -fsSL --max-time 1800 -o image.zip "$url"
unzip -o -q image.zip || python3 -m zipfile -e image.zip .
docker load -i "taskindex-$sha.tar.gz" >/dev/null
REMOTE
  fmt='{{index .Config.Labels "org.opencontainers.image.revision"}}'
  label=$(remote "docker image inspect '$image' --format '$fmt'")
  [[ $label == "$sha" ]] || { printf 'Loaded image is labelled %s, not %s.\n' "$label" "$sha" >&2; exit 1; }
  printf 'loaded and labelled %s\n' "${sha:0:7}" >&2
fi

say "bare repository $host:$bare_on_host"
git push -q "$host:$bare_on_host" "$sha:refs/heads/main"

deploy="cd '$repo_on_host' && set -a && . '$remote_env' && set +a && bash deploy/deploy.sh"
if $plan; then
  say "plan (checkout unchanged)"
  # Fetch only: the plan needs the commit known to the checkout, which stays where it is.
  remote "set -e; cd '$repo_on_host' && git fetch -q origin && $deploy --plan --image '$image' '$sha'"
  say "plan only: nothing deployed"
  exit 0
fi

say "backup before"
bash deploy/pull-backup.sh
say "checkout and plan on $host"
checkout="cd '$repo_on_host' && git fetch -q origin && git checkout -q --detach '$sha'"
remote "set -e; $checkout && $deploy --plan --image '$image' '$sha'"
say "deploy"
remote "set -e; $deploy --image '$image' '$sha'"
say "backup after"
bash deploy/pull-backup.sh
say "released"
remote "cat '$repo_on_host/deploy/.runtime/current.json'"
