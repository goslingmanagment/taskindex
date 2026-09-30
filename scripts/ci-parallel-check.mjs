#!/usr/bin/env node
// CI on the PC runners: the parts of `npm run check` side by side instead of
// one after another (CI speed-up plan 2026-09-30, step B6). GitHub-hosted
// runners keep plain `npm run check`.
//
//   node scripts/ci-parallel-check.mjs
//
// The parts come from `scripts.check` at run time; this file only knows which
// part reads what another one writes. `precheck` runs first and once, as in
// `npm run check`; then every part starts as its own `npm run <part>` (the
// test part keeps its `pretest`), and `check:skin`, which reads the bundle in
// dist/web/assets, runs after `build`. Nothing else reads dist or another
// part's output: tsconfig.json excludes dist and no source imports from it;
// oxlint ignores dist, and its type-aware pass does not read the
// tsconfig.tsbuildinfo that typecheck writes; unused-exports and format:check
// read sources; lint:shell reads deploy/ and scripts/; the tests write only
// to temp directories (tests/api/paths.test.ts serves the web client from one
// via TASKINDEX_WEB_DIR).
//
// Each part logs to its own file under $RUNNER_TEMP; at the end the logs are
// printed in the order of `check`, one `::group::` per part with its exit code
// and time, and the exit code is 1 if any part failed. SIGINT/SIGTERM stop
// every part's process group and print what the parts logged so far. A `check`
// of another shape, or with a part or hook this file does not know, runs as
// plain `npm run check`.
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// `after`: the part whose output this one reads; it runs next in that part's
// lane. `hooks`: the pre/post scripts npm runs inside `npm run <part>`.
/** @type {Map<string, { after?: string, hooks?: string[] }>} */
const PARTS = new Map([
  ['typecheck', {}],
  ['lint', {}],
  ['unused-exports', {}],
  ['format:check', {}],
  ['lint:shell', {}],
  ['build', {}],
  ['check:skin', { after: 'build' }],
  ['test', { hooks: ['pretest'] }],
]);

const unknown = (/** @type {string} */ reason) => ({ ok: false, reason });

/**
 * Lanes of `check`: the parts of a lane run in turn, the lanes side by side.
 * `{ ok: false, reason }` when this file does not know the shape of `check`.
 * @param {Record<string, string>} scripts `scripts` of package.json
 */
export function planCheck(scripts) {
  const has = (/** @type {string} */ name) => Object.hasOwn(scripts, name);
  if (typeof scripts.check !== 'string' || !has('check'))
    return unknown('в package.json нет scripts.check');
  /** @type {string[]} */
  const parts = [];
  for (const piece of scripts.check.split('&&')) {
    const name = /^npm run ([\w:.-]+)$/.exec(piece.trim())?.[1];
    if (!name) return unknown(`«${piece.trim()}» — не «npm run <скрипт>»`);
    if (!PARTS.has(name)) return unknown(`часть ${name} скрипту не знакома`);
    if (!has(name)) return unknown(`скрипта ${name} нет в package.json`);
    if (parts.includes(name)) return unknown(`часть ${name} повторяется`);
    parts.push(name);
  }
  const before = has('precheck') ? ['precheck'] : [];
  for (const name of ['check', ...before, ...parts]) {
    const known = name === 'check' ? before : (PARTS.get(name)?.hooks ?? []);
    for (const hook of [`pre${name}`, `post${name}`])
      if (has(hook) && !known.includes(hook))
        return unknown(`хук ${hook} скрипту не знаком`);
  }
  /** @type {string[][]} */
  const lanes = [];
  for (const name of parts) {
    const after = PARTS.get(name)?.after;
    const lane = after && lanes.find((candidate) => candidate.includes(after));
    if (lane) lane.push(name);
    else if (after)
      return unknown(
        `${name} читает вывод ${after}, а ${after} в check не раньше`,
      );
    else lanes.push([name]);
  }
  return { ok: true, before, parts, lanes };
}

/**
 * @typedef {{ log?: string, started?: number, ms?: number, code?: number,
 *   skipped?: string }} Result
 * @typedef {'SIGINT' | 'SIGTERM'} Signal
 */

const root = resolve(import.meta.dirname, '..');
const seconds = (/** @type {number} */ ms) => `${(ms / 1000).toFixed(1)} с`;
const say = (/** @type {string} */ line) => process.stdout.write(`${line}\n`);

/** @param {Result | undefined} result */
function status(result) {
  if (result?.skipped) return `не запускалась: упала ${result.skipped}`;
  if (result?.started === undefined) return 'не запускалась';
  if (result.code === undefined || result.ms === undefined)
    return `прервана через ${seconds(Date.now() - result.started)}`;
  return result.code === 0
    ? `ok, ${seconds(result.ms)}`
    : `ОШИБКА, код ${result.code}, ${seconds(result.ms)}`;
}

// Signal 0 only asks whether the process group still exists.
/** @param {number} group @param {Signal | 'SIGKILL' | 0} signal */
function signalGroup(group, signal) {
  try {
    process.kill(-group, signal);
    return true;
  } catch {
    return false;
  }
}

/** @param {{ before: string[], parts: string[], lanes: string[][] }} plan */
async function runPlan(plan) {
  const logs = mkdtempSync(
    join(process.env.RUNNER_TEMP ?? tmpdir(), 'taskindex-check-'),
  );
  const order = [...plan.before, ...plan.parts];
  /** @type {Map<string, Result>} */
  const results = new Map();
  // Process groups of the parts started, kept after a part exits: what it
  // left running is stopped with the rest.
  /** @type {Set<number>} */
  const groups = new Set();
  /** @type {Signal | undefined} */
  let stopped;
  const started = Date.now();

  // One part as `npm run <part>` in a process group of its own; true on
  // exit code 0.
  const run = (/** @type {string} */ name) =>
    new Promise((done) => {
      const number = String(order.indexOf(name) + 1).padStart(2, '0');
      const log = join(logs, `${number}-${name.replaceAll(':', '_')}.log`);
      /** @type {Result} */
      const result = { log, started: Date.now() };
      results.set(name, result);
      const fd = openSync(log, 'w');
      const child = spawn('npm', ['run', name], {
        cwd: root,
        stdio: ['ignore', fd, fd],
        detached: true,
      });
      closeSync(fd);
      if (child.pid) groups.add(child.pid);
      let settled = false;
      const finish = (/** @type {number} */ code, message = '') => {
        if (settled) return;
        settled = true;
        if (message) appendFileSync(log, `${message}\n`);
        result.code = code;
        result.ms = Date.now() - (result.started ?? 0);
        if (!stopped) say(`check: ${name} — ${status(result)}`);
        done(code === 0);
      };
      child.once('error', (error) =>
        finish(127, `ci-parallel-check: ${error.message}`),
      );
      child.once('exit', (code, signal) =>
        finish(code ?? 128 + (signal ? constants.signals[signal] : 0)),
      );
    });

  const runLane = async (/** @type {string[]} */ lane) => {
    for (const [index, name] of lane.entries()) {
      if (stopped) return;
      if (await run(name)) continue;
      for (const rest of lane.slice(index + 1))
        results.set(rest, { skipped: name });
      return;
    }
  };

  const report = () => {
    for (const name of order) {
      const result = results.get(name);
      if (!result?.log) {
        say(`${name}: ${status(result)}`);
        continue;
      }
      const text = readFileSync(result.log, 'utf8');
      say(`::group::${name}: ${status(result)}`);
      if (text) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
      say('::endgroup::');
    }
  };

  // The runner signals only the step's process: the parts live in groups of
  // their own, so the signal is passed on and the logs so far are printed.
  // Whatever ignores it (a shell's background job ignores SIGINT) is killed
  // two seconds later; the script ends when the groups are gone.
  const stop = (/** @type {Signal} */ signal) => {
    if (stopped) {
      for (const group of groups) signalGroup(group, 'SIGKILL');
      return;
    }
    stopped = signal;
    for (const group of groups) signalGroup(group, signal);
    report();
    say(`::error::check: остановлен сигналом ${signal}, логи частей выше`);
    process.exitCode = 128 + constants.signals[signal];
    const deadline = Date.now() + 2000;
    const timer = setInterval(() => {
      const alive = [...groups].filter((group) => signalGroup(group, 0));
      if (alive.length && Date.now() < deadline) return;
      for (const group of alive) signalGroup(group, 'SIGKILL');
      clearInterval(timer);
    }, 100);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const first = plan.before.length ? `${plan.before.join(', ')}, затем ` : '';
  const lanes = plan.lanes.map((lane) => lane.join(' → ')).join(' | ');
  say(`check: ${first}параллельно ${lanes}`);
  say(`check: логи частей в ${logs}`);
  let ready = true;
  for (const name of plan.before) {
    ready = await run(name);
    if (!ready) {
      for (const part of plan.parts) results.set(part, { skipped: name });
      break;
    }
  }
  if (ready) await Promise.all(plan.lanes.map(runLane));
  if (stopped) return;
  report();
  if (order.every((name) => results.get(name)?.code === 0))
    say(`check: все части зелёные за ${seconds(Date.now() - started)}`);
  else {
    const failed = order.filter(
      (name) => results.get(name)?.code !== 0 && !results.get(name)?.skipped,
    );
    say(`::error::check: упали ${failed.join(', ')}; их логи в группах выше`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { scripts = {} } = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  );
  const plan = planCheck(scripts);
  if (plan.ok) await runPlan(plan);
  else {
    say(`::notice::check по очереди: ${plan.reason} (ci-parallel-check.mjs)`);
    process.exitCode =
      spawnSync('npm', ['run', 'check'], { cwd: root, stdio: 'inherit' })
        .status ?? 1;
  }
}
