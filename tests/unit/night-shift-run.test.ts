import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunReport } from '../../scripts/night-shift/report.mts';

const run = promisify(execFile);

// The entry points run under plain Node (type stripping, real `.mts`
// imports) and never reach a server here: TASKINDEX_BIN names a CLI that
// does not exist, so every call fails the way a missing key or a dead
// gateway would.
describe('night shift entry points', () => {
  let dir = '';
  let env: NodeJS.ProcessEnv = {};
  const state = () => join(dir, 'state', 'taskindex', 'night-shift');
  const report = async () =>
    JSON.parse(
      await readFile(join(state(), 'last-run.json'), 'utf8'),
    ) as RunReport;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'taskindex-night-shift-'));
    env = {
      ...process.env,
      XDG_STATE_HOME: join(dir, 'state'),
      TASKINDEX_BIN: join(dir, 'no-such-taskindex'),
      NODE_OPTIONS: '',
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a failed report when the board cannot be read', async () => {
    const failure = await run('bash', ['scripts/night-shift/run.sh'], {
      env,
    }).catch((error: { code: number }) => error);
    expect(failure).toMatchObject({ code: 1 });
    const written = await report();
    expect(written).toMatchObject({
      ok: false,
      stages: {
        board: {
          tasks: 0,
          drafts: 0,
          created: 0,
          existing: 0,
          skippedByCap: 0,
        },
      },
      errors: [{ stage: 'board' }],
    });
    expect(written.errors[0]?.message).toContain('taskindex snapshot');
    expect(
      Date.parse(written.window?.to ?? '') -
        Date.parse(written.window?.from ?? ''),
    ).toBe(48 * 3_600_000);
    expect((await stat(state())).mode & 0o777).toBe(0o700);
    expect((await stat(join(state(), 'last-run.json'))).mode & 0o777).toBe(
      0o600,
    );
    expect(
      (await readdir(state())).filter((name) => name.includes('tmp')),
    ).toEqual([]);
  });

  it('still leaves a failed report when the runner crashes before writing one', async () => {
    const failure = await run('bash', ['scripts/night-shift/run.sh'], {
      env: { ...env, NODE_OPTIONS: `--require=${join(dir, 'missing.cjs')}` },
    }).catch((error: { code: number }) => error);
    expect(failure).toMatchObject({ code: 1 });
    const written = await report();
    expect(written).toMatchObject({
      ok: false,
      window: null,
      stages: {},
      errors: [{ stage: 'run' }],
    });
    expect(written.errors[0]?.message).toMatch(
      /^run\.mts завершился с кодом 1: Error: Cannot find module/,
    );
    expect(Date.parse(written.finishedAt)).toBeGreaterThanOrEqual(
      Date.parse(written.startedAt),
    );
    expect(
      (await readdir(state())).filter((name) => name.startsWith('last-run.')),
    ).toEqual(['last-run.json']);
  });

  it('prints the failure lines in the morning instead of silence', async () => {
    await run('bash', ['scripts/night-shift/run.sh'], { env }).catch(
      () => undefined,
    );
    const { stdout } = await run(
      process.execPath,
      ['scripts/night-shift/morning.mts'],
      { env },
    );
    const lines = stdout.trim().split('\n');
    expect(lines[0]).toBe('⚠️ Поломка · доска задач');
    expect(lines[1]).toMatch(
      /^Ночная смена не отработала: taskindex snapshot: /,
    );
    expect(lines[2]).toMatch(/^Предложения не получены: taskindex proposal: /);
    expect(lines).toHaveLength(3);
  });
});
