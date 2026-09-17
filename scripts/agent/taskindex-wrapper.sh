#!/bin/sh
# Обёртка CLI taskindex для sh-сред: мак и Git Bash на Windows (так ходит
# Claude Code). Подставляет ключ агента по среде запуска; идентификатор агента
# зависит от машины: TASKINDEX_MACHINE=mac даёт claude-mac, codex-mac, openclaw;
# win даёт claude-win, codex-win, openclaw-win. Ставится как ~/.local/bin/taskindex
# скриптом scripts/agent/install-mac.sh (или install-win.ps1), который дописывает
# TASKINDEX_CLI_ROOT и TASKINDEX_MACHINE в начало. Явные TASKINDEX_URL и
# TASKINDEX_TOKEN (sandbox из `npm run sandbox`) не трогаются.
set -eu

if [ -z "${TASKINDEX_TOKEN:-}" ]; then
  machine=${TASKINDEX_MACHINE:-mac}
  if [ "$machine" = mac ]; then openclaw=openclaw; else openclaw="openclaw-$machine"; fi
  agent=${TASKINDEX_AGENT:-}
  # OpenClaw first: its agents run Codex or Claude CLI under the gateway and
  # inherit the service env, so the runtime checks below would misattribute.
  if [ -z "$agent" ] && [ -n "${OPENCLAW_SERVICE_MARKER:-}" ]; then agent=$openclaw; fi
  if [ -z "$agent" ] && [ -n "${CLAUDECODE:-}" ]; then agent="claude-$machine"; fi
  if [ -z "$agent" ] && [ -n "${CODEX_THREAD_ID:-}" ]; then agent="codex-$machine"; fi
  if [ -z "$agent" ]; then
    msg="Не определён агент: задайте TASKINDEX_AGENT (claude-$machine, codex-$machine, $openclaw)"
    msg="$msg или TASKINDEX_URL и TASKINDEX_TOKEN"
    printf '{"ok":false,"code":"client_error","message":"%s","retryable":false}\n' "$msg"
    exit 1
  fi
  env_file="${XDG_CONFIG_HOME:-$HOME/.config}/taskindex/$agent.env"
  if [ ! -r "$env_file" ]; then
    msg="Нет файла ключа $env_file: см. README, раздел «Агенты»"
    printf '{"ok":false,"code":"client_error","message":"%s","retryable":false}\n' "$msg"
    exit 1
  fi
  # shellcheck disable=SC1090
  . "$env_file"
  export TASKINDEX_URL TASKINDEX_TOKEN
fi

exec node "${TASKINDEX_CLI_ROOT:?}/dist/cli/index.js" "$@"
