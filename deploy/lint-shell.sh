#!/usr/bin/env bash
# Статический слой deploy/ (план 10, доп. шаг 20; план 11, шаги 10–11): bash -n и
# анализатор shell для скриптов, tsc и oxlint для deploy/*.mjs, предел 120 символов в строке.
# Вызов: npm run lint:shell.
set -Eeuo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
shopt -s nullglob
scripts=(deploy/*.sh deploy/drill/*.sh scripts/agent/*.sh scripts/night-shift/*.sh)
bash -n "${scripts[@]}"
if command -v shellcheck >/dev/null; then
  shellcheck -x -S warning "${scripts[@]}"
else
  printf '%s\n' 'lint:shell: shellcheck не установлен, проверка пропущена (brew install shellcheck /' \
    'apt install shellcheck); в CI она обязательна.' >&2
  # В CI (в том числе на раннерах ПК без apt) гейт без shellcheck молча не проходит.
  [[ ${CI:-} != true ]] || exit 1
fi
# Символы, не байты: awk считает по-разному на macOS и Linux, bash ${#line} — по локали UTF-8.
for candidate in C.UTF-8 en_US.UTF-8 UTF-8; do
  if LC_ALL=$candidate locale charmap 2>/dev/null | grep -q UTF-8; then export LC_ALL=$candidate; break; fi
done
long=''
for file in "${scripts[@]}"; do
  n=0
  while IFS= read -r line || [[ -n $line ]]; do
    n=$((n + 1))
    (( ${#line} <= 120 )) || long+="$file:$n: ${#line} символов"$'\n'
  done < "$file"
done
[[ -z $long ]] || { printf '%s\n' 'lint:shell: строки длиннее 120 символов:' "$long" >&2; exit 1; }
npx tsc -p tsconfig.deploy.json
npx oxlint deploy
