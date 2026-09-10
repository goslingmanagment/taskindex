import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';

const run = promisify(execFile);
const script = resolve('scripts/sandbox.mts');
const sandbox = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  run(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: resolve('.'),
    env: { ...process.env, ...env },
    maxBuffer: 1 << 20,
  });

interface Description {
  pid: number;
  url: string;
  directory: string;
  stateHome: string;
  agents: Record<string, { scope: string }>;
  tokens: Record<string, string>;
}

let started: Description | undefined;

afterAll(async () => {
  if (started)
    await sandbox(['--stop'], { TASKINDEX_SANDBOX: started.directory }).catch(
      () => undefined,
    );
});

describe('scripts/sandbox.mts', () => {
  it('starts a disposable server with owner and agent keys, serves the real CLI, and removes everything on --stop', async () => {
    const { stdout } = await sandbox(['--json']);
    started = JSON.parse(stdout) as Description;
    expect(started.directory).not.toContain(resolve('.'));
    expect(started.agents).toMatchObject({
      claude: { scope: 'write' },
      codex: { scope: 'tasks' },
    });
    expect(stdout).not.toContain('BETTER_AUTH_SECRET');

    const health = (await (await fetch(`${started.url}/health`)).json()) as {
      ok: boolean;
      writes: string;
      build: string;
    };
    expect(health).toMatchObject({
      ok: true,
      writes: 'open',
      build: 'sandbox',
    });

    const output: Record<string, unknown>[] = [];
    const code = await runCli(
      ['task', 'create', '--area', 'agency', '--title', 'Задача из sandbox'],
      {
        env: {
          TASKINDEX_URL: started.url,
          TASKINDEX_TOKEN: started.tokens.claude!,
          XDG_STATE_HOME: started.stateHome,
        },
        stdout: (line) =>
          output.push(JSON.parse(line) as Record<string, unknown>),
        stderr: () => undefined,
      },
    );
    expect(code).toBe(0);
    expect(output.at(-1)).toMatchObject({
      ok: true,
      events: [{ actorId: 'agent:claude', command: 'task.create' }],
    });

    const token = await sandbox(['--token', 'codex'], {
      TASKINDEX_SANDBOX: started.directory,
    });
    expect(token.stdout).toBe(
      `export TASKINDEX_TOKEN='${started.tokens.codex}'\n`,
    );

    const stopped = await sandbox(['--stop'], {
      TASKINDEX_SANDBOX: started.directory,
    });
    expect(JSON.parse(stopped.stdout)).toMatchObject({
      ok: true,
      removed: started.directory,
    });
    await expect(stat(started.directory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fetch(`${started.url}/health`)).rejects.toThrow();
    started = undefined;
  }, 60_000);
});
