#!/usr/bin/env bash
# Ночная смена: запуск кроном OpenClaw night-shift:v1 из основного чекаута.
# Запускает run.mts, который сам пишет last-run.json; если он упал до записи
# отчёта, отчёт с ok: false пишет этот скрипт, чтобы утро узнало о сбое.
# Каталог состояния: ${XDG_STATE_HOME:-~/.local/state}/taskindex/night-shift (0700).
set -Eeuo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
state="${XDG_STATE_HOME:-$HOME/.local/state}/taskindex/night-shift"
mkdir -p "$state"
chmod 700 "$state"
# Ключ ночной смены задаётся явно: под шлюзом OpenClaw обёртка иначе возьмёт
# ключ Бобра. Обёртка taskindex и node лежат в ~/.local/bin.
export TASKINDEX_AGENT=night-shift
export PATH="$HOME/.local/bin:$PATH"

started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
stderr="$state/run.stderr"
code=0
node "$repo/scripts/night-shift/run.mts" 2>"$stderr" || code=$?
# 0: прогон чистый; 3: отчёт записан с ok: false; другое: падение до отчёта.
case $code in
  0) exit 0 ;;
  3) exit 1 ;;
esac

# Первая строка ошибки Node, иначе последняя строка stderr.
reason=$(grep -m 1 -E '^[A-Za-z]*Error([: ]|$)' "$stderr" 2>/dev/null || tail -n 1 "$stderr" 2>/dev/null || true)
reason=${reason//[[:cntrl:]\"\\]/ }
reason=${reason:0:300}
message="run.mts завершился с кодом $code${reason:+: $reason}"
finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
tmp=$(mktemp "$state/last-run.XXXXXX")
{
  printf '{"startedAt":"%s","finishedAt":"%s","ok":false,"window":null,' "$started" "$finished"
  printf '"stages":{},"errors":[{"stage":"run","message":"%s"}]}\n' "$message"
} >"$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$state/last-run.json"
printf '%s\n' "$message" >&2
exit 1
