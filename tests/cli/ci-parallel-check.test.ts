import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planCheck } from '../../scripts/ci-parallel-check.mjs';

const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
};

// A check of the shape the script knows, with today's bodies of the parts
// (the first test holds them to the pinned ones).
const known: Record<string, string> = {
  ...Object.fromEntries(
    [
      'preflight',
      'precheck',
      'pretest',
      'typecheck',
      'lint',
      'build',
      'check:skin',
      'test',
    ].map((name) => [name, scripts[name] ?? '']),
  ),
  check:
    'npm run typecheck && npm run lint && npm run build && npm run check:skin && npm run test',
};

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
});

// runPlan in a child process (it takes over SIGINT and SIGTERM) on the
// `scripts` of a temp package.json; the child records the signals it sends.
function start(parts: Record<string, string>, lanes: string[][]) {
  const dir = mkdtempSync(join(tmpdir(), 'taskindex-parallel-check-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ private: true, scripts: parts }),
  );
  const script = pathToFileURL(resolve('scripts/ci-parallel-check.mjs')).href;
  const plan = { before: [], parts: lanes.flat(), lanes };
  const driver = `
    import { writeFileSync } from 'node:fs';
    import { runPlan } from ${JSON.stringify(script)};
    const sent = [];
    const kill = process.kill.bind(process);
    process.kill = (pid, signal) => {
      if (signal !== 0) sent.push([pid, signal]);
      return kill(pid, signal);
    };
    process.on('exit', () => writeFileSync('sent.json', JSON.stringify(sent)));
    await runPlan(${JSON.stringify(plan)}, process.cwd());
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', driver], {
    cwd: dir,
    env: { ...process.env, RUNNER_TEMP: dir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  cleanup.push(() => child.kill('SIGKILL'));
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  const exited = new Promise<number | null>((done) =>
    child.once('exit', (code) => done(code)),
  );
  return {
    dir,
    child,
    exited,
    stdout: () => stdout,
    sent: () =>
      JSON.parse(readFileSync(join(dir, 'sent.json'), 'utf8')) as [
        number,
        string,
      ][],
  };
}

describe('scripts/ci-parallel-check.mjs: planCheck', () => {
  // A new part or hook of check, or a new body of one (a path added to lint
  // too), goes into PARTS or INNER of the script first; without it the PC
  // runners fall back to plain `npm run check`.
  it('knows every part and hook of check in package.json and their bodies', () => {
    const plan = planCheck(scripts);
    expect(plan.ok || plan.reason).toBe(true);
    if (plan.ok)
      expect(plan.lanes.flat().toSorted()).toEqual(plan.parts.toSorted());
  });

  it('runs precheck once, then the parts side by side and check:skin after build', () => {
    expect(planCheck(known)).toEqual({
      ok: true,
      before: ['precheck'],
      parts: ['typecheck', 'lint', 'build', 'check:skin', 'test'],
      lanes: [['typecheck'], ['lint'], ['build', 'check:skin'], ['test']],
    });
    const withoutPrecheck = Object.fromEntries(
      Object.entries(known).filter(([name]) => name !== 'precheck'),
    );
    expect(planCheck(withoutPrecheck)).toMatchObject({ ok: true, before: [] });
  });

  it.each<[string, Record<string, string>, string]>([
    [
      'a command that is not npm run',
      { check: 'npm run lint && vitest run' },
      '«vitest run»',
    ],
    ['arguments', { check: 'npm run lint -- --fix' }, 'npm run <скрипт>'],
    [
      'another operator',
      { check: 'npm run lint || npm run test' },
      'npm run <скрипт>',
    ],
    [
      'an unknown part',
      { check: 'npm run lint && npm run e2e', e2e: 'playwright test' },
      'часть e2e',
    ],
    [
      'a missing script',
      { check: 'npm run lint && npm run unused-exports' },
      'скрипта unused-exports',
    ],
    [
      'a repeated part',
      { check: 'npm run lint && npm run lint' },
      'повторяется',
    ],
    [
      'check:skin before build',
      { check: 'npm run check:skin && npm run build' },
      'check:skin читает вывод build',
    ],
    [
      'check:skin without build',
      { check: 'npm run lint && npm run check:skin' },
      'check:skin читает вывод build',
    ],
    ['an unknown hook of a part', { prebuild: 'rm -rf dist' }, 'хук prebuild'],
    ['a posttest hook', { posttest: 'node report.mjs' }, 'хук posttest'],
    ['a postcheck hook', { postcheck: 'node report.mjs' }, 'хук postcheck'],
    // Side by side, test ran while build emptied dist: what each part reads
    // and writes is known for its pinned body only.
    [
      'another body of a part',
      { test: 'npm run build && vitest run' },
      'тело test',
    ],
    [
      'another body of a hook of a part',
      { pretest: 'npm run -s preflight && rm -rf dist' },
      'тело pretest',
    ],
    [
      'another body of a script a hook runs',
      { preflight: 'node scripts/preflight.mjs && vite build' },
      'тело preflight',
    ],
    [
      'a hook of a script a hook runs',
      { prepreflight: 'rm -rf dist' },
      'хук prepreflight',
    ],
  ])('falls back to npm run check on %s', (_, change, reason) => {
    const plan = planCheck({ ...known, ...change });
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toContain(reason);
  });
});

describe('scripts/ci-parallel-check.mjs: runPlan', () => {
  // On the shared CI PC every runner runs as one user: the number of a
  // finished part's empty group may go to another job's process, which a
  // stop must not signal.
  it('stops the groups of running parts only', async () => {
    const run = start(
      {
        fast: 'ps -o pgid= -p $$ > fast.tmp && mv fast.tmp fast.pgid',
        slow: 'ps -o pgid= -p $$ > slow.tmp && mv slow.tmp slow.pgid; sleep 30',
      },
      [['fast'], ['slow']],
    );
    await vi.waitFor(
      () => {
        expect(run.stdout()).toContain('check: fast — ok');
        expect(existsSync(join(run.dir, 'slow.pgid'))).toBe(true);
      },
      { timeout: 20000, interval: 50 },
    );
    run.child.kill('SIGTERM');
    expect(await run.exited).toBe(143);
    const group = (name: string) =>
      Number(readFileSync(join(run.dir, `${name}.pgid`), 'utf8').trim());
    const signalled = run.sent().map(([pid]) => -pid);
    expect(signalled).toContain(group('slow'));
    expect(signalled).not.toContain(group('fast'));
  }, 40000);

  it('folds the log of a passing part and keeps a failed one in view', async () => {
    const run = start({ good: 'echo fine', bad: 'echo boom && exit 3' }, [
      ['good'],
      ['bad'],
    ]);
    expect(await run.exited).toBe(1);
    const out = run.stdout();
    expect(out).toMatch(
      /^::group::good: ok, .*\n(?:.*\n)*?fine\n::endgroup::$/m,
    );
    expect(out).not.toContain('::group::bad');
    expect(out).toMatch(/^bad: ОШИБКА, код 3, .*\n(?:.*\n)*?boom\n/m);
  });
});
