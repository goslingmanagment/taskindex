import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
// deploy.sh --plan is the read-only preview of a release (TI-072): it must work on a
// machine without Docker (a Mac, a CI runner) and must not create runtime state.
describe('deploy.sh --plan', () => {
  let repo = '';
  let head = '';
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'taskindex-plan-'));
    await cp('deploy', join(repo, 'deploy'), { recursive: true });
    await rm(join(repo, 'deploy', '.runtime'), {
      recursive: true,
      force: true,
    });
    const git = (...args: string[]) =>
      run('git', [
        '-C',
        repo,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.test',
        ...args,
      ]);
    await git('init', '-q', '-b', 'main');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'release');
    head = (await git('rev-parse', 'HEAD')).stdout.trim();
  });
  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('prints the plan without Docker and without touching the checkout', async () => {
    const { stdout } = await run(
      'bash',
      ['deploy/deploy.sh', '--plan', 'HEAD'],
      {
        cwd: repo,
        env: { ...process.env, DOCKER_HOST: 'unix:///nonexistent' },
      },
    );
    const plan = JSON.parse(stdout) as Record<string, unknown>;
    expect(plan.target).toBe(head);
    expect(plan.previousRef).toBe('main');
    expect(plan.willChangeCheckout).toBe(true);
    expect(plan.docker).toBe('unavailable');
    expect(plan.lock).toBe('free');
    expect(plan.current).toBeNull();
    expect(plan.image).toMatchObject({
      ref: `taskindex:${head}`,
      present: 'unavailable',
    });
    expect(plan.phases).toEqual(
      expect.arrayContaining(['backup-and-manifest', 'migrate', 'open-writes']),
    );
    expect((plan.phases as string[]).indexOf('migrate')).toBeGreaterThan(
      (plan.phases as string[]).indexOf('backup-and-manifest'),
    );
    expect(plan.preflight).toMatchObject({ checkoutClean: true });
    await expect(stat(join(repo, 'deploy', '.runtime'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      (
        await run('git', ['-C', repo, 'symbolic-ref', '--short', 'HEAD'])
      ).stdout.trim(),
    ).toBe('main');
  });

  it('reports a held lock and the recorded release without changing them', async () => {
    const runtime = await mkdtemp(join(tmpdir(), 'taskindex-runtime-'));
    await run('bash', [
      '-c',
      `printf '%s' '{"image":"taskindex:x","build":"x","deployment":"d","replicaUrl":"file:///r","status":"open"}' > "${runtime}/current.json"`,
    ]);
    const { stdout } = await run(
      'bash',
      ['deploy/deploy.sh', '--plan', '--image', 'taskindex:custom', 'HEAD'],
      {
        cwd: repo,
        env: {
          ...process.env,
          DOCKER_HOST: 'unix:///nonexistent',
          TASKINDEX_RUNTIME_DIR: runtime,
        },
      },
    );
    const plan = JSON.parse(stdout) as Record<string, unknown>;
    expect(plan.current).toMatchObject({ status: 'open', deployment: 'd' });
    expect(plan.previousRelease).toBeNull();
    expect(plan.image).toMatchObject({ ref: 'taskindex:custom' });
    expect(await readFile(join(runtime, 'current.json'), 'utf8')).toContain(
      '"status":"open"',
    );
    await rm(runtime, { recursive: true, force: true });
  });

  it('refuses an unknown commit and a missing target', async () => {
    await expect(
      run('bash', ['deploy/deploy.sh', '--plan', 'nope'], { cwd: repo }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Unknown commit'),
    });
    await expect(
      run('bash', ['deploy/deploy.sh', '--plan'], { cwd: repo }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Usage:'),
    });
  });
});
