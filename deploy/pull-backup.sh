#!/usr/bin/env bash
# Off-site copy of the production database, pulled from the owner's Mac (decision 2026-09-11:
# no S3, no external heartbeat; the Mac keeps dated copies of the DB file and the JSON export).
#
#   bash deploy/pull-backup.sh                      # → ~/Backups/taskindex/<UTC>/{taskindex.db,export.json}
#   TASKINDEX_HOST=root@45.8.230.111 TASKINDEX_BACKUP_DIR=~/Backups/taskindex bash deploy/pull-backup.sh
#
# Server side: a consistent copy via the SQLite backup API (deploy/database.mjs backup, inside the
# running app container) and `taskindex-admin export` (logical export the importer accepts).
# Keeps the last TASKINDEX_BACKUP_KEEP (default 30) copies locally. Never writes to the server
# except the temporary /data/backups/pull-*.db, which is removed after transfer.
set -Eeuo pipefail
umask 077
host=${TASKINDEX_HOST:-root@45.8.230.111}
repo_on_host=${TASKINDEX_REMOTE_REPO:-/opt/taskindex}
keep=${TASKINDEX_BACKUP_KEEP:-30}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="${TASKINDEX_BACKUP_DIR:-$HOME/Backups/taskindex}/$stamp"
mkdir -p "$target"
remote_copy="/data/backups/pull-$stamp.db"
# Both commands run through the release compose file (deploy/compose.sh) so the image, volume
# and env come from deploy/.runtime/current.json, exactly like deploy.sh.
app="cd '$repo_on_host' && bash deploy/compose.sh exec -T app"
ssh "$host" "$app node deploy/database.mjs backup '$remote_copy' >/dev/null \
  && $app cat '$remote_copy' && $app rm -f '$remote_copy'" > "$target/taskindex.db"
ssh "$host" "$app taskindex-admin export" > "$target/export.json"
size=$(wc -c < "$target/taskindex.db" | tr -d ' ')
[[ $size -gt 4096 ]] || { printf 'Backup looks empty (%s bytes): %s\n' "$size" "$target" >&2; exit 1; }
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$target/export.json"
# Rotate: keep the newest $keep directories (portable: BSD tail on macOS, GNU on Linux).
ls -1d "${target%/*}"/*/ 2>/dev/null | sort -r | tail -n +"$((keep + 1))" | while read -r old; do rm -rf "$old"; done
printf '{"ok":true,"path":"%s","dbBytes":%s}\n' "$target" "$size"
