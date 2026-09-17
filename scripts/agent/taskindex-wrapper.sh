#!/bin/sh
# Обёртка CLI taskindex для мака: подставляет ключ агента по среде запуска.
# Ставится как ~/.local/bin/taskindex скриптом scripts/agent/install-mac.sh.
# Явные TASKINDEX_URL и TASKINDEX_TOKEN (sandbox из `npm run sandbox`) не трогаются.
set -eu

if [ -z "${TASKINDEX_TOKEN:-}" ]; then
  agent=${TASKINDEX_AGENT:-}
  # OpenClaw first: its agents run Codex or Claude CLI under the gateway and
  # inherit the service env, so the runtime checks below would misattribute.
  if [ -z "$agent" ] && [ -n "${OPENCLAW_SERVICE_MARKER:-}" ]; then agent=openclaw; fi
  if [ -z "$agent" ] && [ -n "${CLAUDECODE:-}" ]; then agent=claude-mac; fi
  if [ -z "$agent" ] && [ -n "${CODEX_THREAD_ID:-}" ]; then agent=codex-mac; fi
  if [ -z "$agent" ]; then
    msg='Не определён агент: задайте TASKINDEX_AGENT (claude-mac, codex-mac, openclaw)'
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
