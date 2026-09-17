#!/usr/bin/env bash
# Установка CLI taskindex и скилла для агентов на маке владельца.
# Запуск из корня репозитория (чекаут или worktree с нужной версией):
#   bash scripts/agent/install-mac.sh
# Делает: сборку, npm pack, установку пакета в свой префикс
# ~/.local/lib/taskindex-cli (не в общий npm -g: там bin-ссылка заняла бы имя
# обёртки), обёртку ~/.local/bin/taskindex, каталог ключей ~/.config/taskindex
# (0700) и симлинки скилла для Claude Code (~/.claude/skills) и Codex
# (~/.agents/skills). Ключи не создаёт: см. README.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
node scripts/preflight.mjs

skill_target=${TASKINDEX_SKILL_TARGET:-$root/skills/taskindex}
bin_dir=${TASKINDEX_BIN_DIR:-$HOME/.local/bin}
prefix=${TASKINDEX_CLI_PREFIX:-$HOME/.local/lib/taskindex-cli}
config_dir=${XDG_CONFIG_HOME:-$HOME/.config}/taskindex

echo "build" >&2
npm run -s build >/dev/null
tarball=$(npm pack --silent 2>/dev/null | tail -n 1)
echo "npm i -g --prefix $prefix $tarball" >&2
npm i -g --silent --prefix "$prefix" "./$tarball"
rm -f "$tarball"
cli_root=$prefix/lib/node_modules/taskindex
[ -f "$cli_root/dist/cli/index.js" ] || { echo "не найден $cli_root/dist/cli/index.js" >&2; exit 1; }

mkdir -p "$bin_dir" "$config_dir"
chmod 700 "$config_dir"
if [ -L "$bin_dir/taskindex" ]; then
  echo "$bin_dir/taskindex был симлинком ($(readlink "$bin_dir/taskindex")): заменяю обёрткой" >&2
  rm -f "$bin_dir/taskindex"
fi
{
  echo "#!/bin/sh"
  echo "# Сгенерировано scripts/agent/install-mac.sh $(date -u +%Y-%m-%dT%H:%M:%SZ) из $root"
  echo "TASKINDEX_CLI_ROOT=\"$cli_root\"; export TASKINDEX_CLI_ROOT"
  echo 'TASKINDEX_MACHINE="mac"; export TASKINDEX_MACHINE'
  sed '1d' scripts/agent/taskindex-wrapper.sh
} > "$bin_dir/taskindex"
chmod 755 "$bin_dir/taskindex"

for dir in "$HOME/.claude/skills" "$HOME/.agents/skills"; do
  mkdir -p "$dir"
  if [ -e "$dir/taskindex" ] && [ ! -L "$dir/taskindex" ]; then
    echo "$dir/taskindex существует и не симлинк: не трогаю" >&2
    continue
  fi
  ln -sfn "$skill_target" "$dir/taskindex"
done

cat >&2 <<MSG
Готово:
  CLI        $cli_root (версия $(node -e 'console.log(require("./package.json").version)'))
  обёртка    $bin_dir/taskindex
  ключи      $config_dir/<agent>.env  (TASKINDEX_URL=…, TASKINDEX_TOKEN=…; chmod 600)
  скилл      ~/.claude/skills/taskindex и ~/.agents/skills/taskindex → $skill_target
Проверка:    TASKINDEX_AGENT=claude-mac taskindex me
MSG
