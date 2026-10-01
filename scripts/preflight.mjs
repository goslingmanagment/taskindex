#!/usr/bin/env node
// Проверка версии Node до тестов, dev, e2e и sandbox: под другой мажорной
// версией нативный better-sqlite3 не загружается и падает без слов о версии.
// Машинно-специфичные пути сюда не зашиваются; способ переключения в CLAUDE.md.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function checkNode(version, engines) {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const range = /^>=(\d+)\.(\d+)\.\d+ <(\d+)$/.exec(engines);
  if (!range)
    return {
      ok: false,
      message: `Не удалось разобрать engines.node "${engines}" в package.json.`,
    };
  const [, lowMajor, lowMinor, highMajor] = range.map(Number);
  const ok =
    major < highMajor &&
    (major > lowMajor || (major === lowMajor && minor >= lowMinor));
  if (ok) return { ok: true };
  return {
    ok: false,
    message: [
      `TaskIndex требует Node ${engines}; запущен v${version}.`,
      'С другой мажорной версией не загружается нативный модуль better-sqlite3.',
      'Переключитесь на закреплённую версию из .node-version: `fnm use` или `nvm use`',
      'в корне репозитория (см. AGENTS.md, раздел «Окружение и проверки»), затем повторите команду.',
    ].join('\n'),
  };
}

export function readPins(root = new URL('../', import.meta.url)) {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const pinned = readFileSync(new URL('.node-version', root), 'utf8').trim();
  return { engines: pkg.engines.node, pinned };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { engines, pinned } = readPins();
  const result = checkNode(process.versions.node, engines);
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exit(1);
  }
  if (process.versions.node !== pinned)
    process.stderr.write(
      `Внимание: закреплён Node ${pinned}, запущен ${process.version}.\n`,
    );
}
