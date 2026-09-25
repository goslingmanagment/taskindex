#!/usr/bin/env bash
# Off-site copy of the production database, pulled from the owner's Mac (decision 2026-09-11:
# no S3, no external heartbeat; the Mac keeps dated copies of the DB file and the JSON export).
#
#   bash deploy/pull-backup.sh                      # → ~/Backups/taskindex/<UTC>/{taskindex.db,export.json}
#   TASKINDEX_HOST=root@45.8.230.111 TASKINDEX_BACKUP_DIR=~/Backups/taskindex bash deploy/pull-backup.sh
#
# Server side: a consistent copy via the SQLite backup API (deploy/database.mjs backup, inside the
# running app container) and `taskindex-admin export` (logical export the importer accepts).
# Keeps the last TASKINDEX_BACKUP_KEEP (default 30) dated copies locally; other folders of the
# backup directory (logs/, releases/, hand-made ones) are neither counted nor removed. Never
# writes to the server except the temporary /data/backups/pull-*.db, removed after transfer.
# launchd on the Mac runs a copy of this file: after changing it, reinstall the copy
# (deploy/README.md, «Копии на маке»).
set -Eeuo pipefail
umask 077
host=${TASKINDEX_HOST:-root@45.8.230.111}
repo_on_host=${TASKINDEX_REMOTE_REPO:-/opt/taskindex}
keep=${TASKINDEX_BACKUP_KEEP:-30}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="${TASKINDEX_BACKUP_DIR:-$HOME/Backups/taskindex}/$stamp"
mkdir -p "$target"
remote_copy="/data/backups/pull-$stamp.db"
# Both commands run through the release compose file (deploy/compose.sh): image, volume and
# deployment come from deploy/.runtime/current.json, exactly like deploy.sh; compose still
# interpolates BASE_URL and BETTER_AUTH_SECRET, so the server env file (root-only, outside
# git) is sourced first.
remote_env=${TASKINDEX_REMOTE_ENV:-/etc/taskindex/taskindex.env}
app="cd '$repo_on_host' && set -a && . '$remote_env' && set +a && bash deploy/compose.sh exec -T app"
ssh "$host" "$app node deploy/database.mjs backup '$remote_copy' >/dev/null \
  && $app cat '$remote_copy' \
  && $app rm -f '$remote_copy' '$remote_copy-wal' '$remote_copy-shm'" > "$target/taskindex.db"
ssh "$host" "$app taskindex-admin export" > "$target/export.json"
size=$(wc -c < "$target/taskindex.db" | tr -d ' ')
[[ $size -gt 4096 ]] || { printf 'Backup looks empty (%s bytes): %s\n' "$size" "$target" >&2; exit 1; }
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$target/export.json"
# Rotate: keep the newest $keep dated copies (portable: BSD tail on macOS, GNU on Linux).
copies=("${target%/*}"/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z/)
printf '%s\n' "${copies[@]}" | sort -r | tail -n +"$((keep + 1))" | while read -r old; do rm -rf "$old"; done
printf '{"ok":true,"path":"%s","dbBytes":%s}\n' "$target" "$size"
