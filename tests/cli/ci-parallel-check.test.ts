import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planCheck } from '../../scripts/ci-parallel-check.mjs';

const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
};

// A check of the shape the script knows, apart from today's package.json.
const known: Record<string, string> = {
  preflight: 'node scripts/preflight.mjs',
  precheck: 'npm run -s preflight',
  pretest: 'npm run -s preflight',
  check:
    'npm run typecheck && npm run lint && npm run build && npm run check:skin && npm run test',
  typecheck: 'tsc --noEmit',
  lint: 'oxlint src',
  build: 'vite build && tsdown',
  'check:skin': 'node scripts/check-skin.mjs',
  test: 'vitest run',
};

describe('scripts/ci-parallel-check.mjs', () => {
  // A new part or hook of check goes into PARTS of the script first;
  // without it the PC runners fall back to plain `npm run check`.
  it('knows every part and hook of check in package.json', () => {
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
  ])('falls back to npm run check on %s', (_, change, reason) => {
    const plan = planCheck({ ...known, ...change });
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toContain(reason);
  });
});
