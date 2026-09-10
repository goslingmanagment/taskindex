#!/usr/bin/env node
// Локальный гейт релиза (TI-016): те же команды, что job `check` в .github/workflows/ci.yml,
// в том же порядке, плюс отчёт с версиями инструментов и commit. Ничего не деплоит.
//   node scripts/gate.mjs [--image] [--strict] [--skip-e2e] [--install-browsers]
//   --image            дополнительно собрать образ как CI (label org.opencontainers.image.revision)
//   --strict           отказ при незакоммиченных изменениях: чужой зелёный check не засчитывается
//   --skip-e2e         без Playwright (только для быстрой проверки, релиз так не проходит)
//   --install-browsers выполнить `npx playwright install --with-deps chromium`, как в CI
// Отчёт: test-results/gate.json (commit, dirty, tools, шаги, image.id).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const flags = new Set(process.argv.slice(2));
for (const flag of flags)
  if (
    !['--image', '--strict', '--skip-e2e', '--install-browsers'].includes(flag)
  ) {
    process.stderr.write(`gate.mjs: неизвестный флаг ${flag}\n`);
    process.exit(2);
  }
/** @param {string} command @param {string[]} args @param {{ capture?: boolean }} [options] */
const exec = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    env: process.env,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
};
const git = (/** @type {string[]} */ ...args) =>
  exec('git', args, { capture: true }).stdout.trim();
const commit = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain') !== '';
if (dirty && flags.has('--strict')) {
  process.stderr.write(
    'gate.mjs: рабочее дерево содержит изменения; гейт засчитывается только чистому коммиту\n',
  );
  process.exit(1);
}
const pinned = readFileSync('.node-version', 'utf8').trim();
const tools = {
  node: process.versions.node,
  nodePinned: pinned,
  npm: exec('npm', ['--version'], { capture: true }).stdout.trim(),
  docker:
    exec('docker', ['--version'], { capture: true }).stdout.trim() || null,
};
/** @type {{ name: string, command: string, ok: boolean, ms: number }[]} */
const steps = [];
/** @param {string} name @param {string} command @param {string[]} args */
const step = (name, command, args) => {
  const started = Date.now();
  process.stderr.write(`\n=== gate: ${name}\n`);
  const { status } = exec(command, args);
  steps.push({
    name,
    command: [command, ...args].join(' '),
    ok: status === 0,
    ms: Date.now() - started,
  });
  if (status !== 0) finish(1);
};
/** @type {{ tag: string, id: string, label: string } | null} */
let image = null;
/** @param {number} code */
const finish = (code) => {
  mkdirSync('test-results', { recursive: true });
  const report = {
    commit,
    dirty,
    tools,
    steps,
    image,
    ok: code === 0,
    at: new Date().toISOString(),
  };
  writeFileSync(
    'test-results/gate.json',
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stderr.write(
    `\ngate: ${code === 0 ? 'зелёный' : 'ОТКАЗ'} для ${commit}${dirty ? ' (dirty)' : ''}; отчёт test-results/gate.json\n`,
  );
  process.exit(code);
};
if (process.versions.node !== pinned)
  process.stderr.write(
    `gate.mjs: закреплён Node ${pinned}, запущен ${process.versions.node}\n`,
  );
step('check', 'npm', ['run', 'check']);
step('build', 'npm', ['run', 'build']);
if (flags.has('--install-browsers'))
  step('playwright-install', 'npx', [
    'playwright',
    'install',
    '--with-deps',
    'chromium',
  ]);
if (!flags.has('--skip-e2e')) step('e2e', 'npm', ['run', 'e2e']);
if (flags.has('--image')) {
  const tag = `taskindex:${commit}`;
  step('image', 'docker', [
    'build',
    '--build-arg',
    `BUILD=${commit}`,
    '--label',
    `org.opencontainers.image.revision=${commit}`,
    '-t',
    tag,
    '-f',
    'deploy/Dockerfile',
    '.',
  ]);
  const id = exec('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], {
    capture: true,
  }).stdout.trim();
  const label = exec(
    'docker',
    [
      'image',
      'inspect',
      '--format',
      '{{index .Config.Labels "org.opencontainers.image.revision"}}',
      tag,
    ],
    { capture: true },
  ).stdout.trim();
  image = { tag, id, label };
  if (label !== commit) {
    process.stderr.write(
      `gate.mjs: метка образа ${label} не равна ${commit}\n`,
    );
    finish(1);
  }
}
finish(0);
