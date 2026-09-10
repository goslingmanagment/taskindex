import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, it, expect } from 'vitest';
import {
  migrate,
  migrationsDirectory,
  openDatabase,
} from '../../src/server/db.js';
import { webDirectory } from '../../src/server/config.js';
import { runAdmin } from '../../src/cli/admin-run.js';
const root = process.cwd();
const cleanup: (() => void)[] = [];
afterEach(() => {
  process.chdir(root);
  cleanup.splice(0).forEach((fn) => fn());
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskindex-paths-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
it('resolves migrations and the web bundle relative to the module, not the working directory', () => {
  process.chdir(scratch());
  expect(process.cwd()).not.toBe(root);
  expect(existsSync('drizzle')).toBe(false);
  const migrations = migrationsDirectory();
  expect(migrations).toBe(resolve(root, 'drizzle/v2'));
  expect(readdirSync(migrations)).toContain('0000_taskindex.sql');
  const db = openDatabase(':memory:');
  cleanup.push(() => db.close());
  expect(() => migrate(db)).not.toThrow();
  expect(webDirectory()).toBe(resolve(root, 'dist/web'));
  expect(webDirectory().endsWith(`${sep}dist${sep}web`)).toBe(true);
  expect(webDirectory('/srv/taskindex/web')).toBe('/srv/taskindex/web');
});
const freePort = () =>
  new Promise<number>((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolvePort(port));
    });
  });
it('starts from another directory, binds to loopback outside production and reports the address without secrets', async () => {
  const dir = scratch();
  const databasePath = join(dir, 'server.db');
  const secret = 'test-only-32-character-secret-value-never-used-outside-tests';
  expect(
    await runAdmin(['migrate'], {
      env: { DATABASE_PATH: databasePath },
      stdout: () => {},
    }),
  ).toBe(0);
  const port = await freePort();
  const child = spawn(
    process.execPath,
    // tsx by absolute path: bare specifiers resolve from the temp cwd.
    [
      '--import',
      resolve(root, 'node_modules/tsx/dist/loader.mjs'),
      resolve(root, 'src/server/index.ts'),
    ],
    {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        PORT: String(port),
        DATABASE_PATH: databasePath,
        BETTER_AUTH_SECRET: secret,
        TASKINDEX_WEB_DIR: dir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  cleanup.push(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const started = Date.now();
  while (!stdout.includes('"event":"listening"')) {
    if (child.exitCode !== null || Date.now() - started > 12_000) {
      await new Promise((r) => setTimeout(r, 100));
      throw new Error(`server did not start: ${stdout}\n${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const line = stdout
    .split('\n')
    .find((l) => l.includes('"event":"listening"'))!;
  expect(JSON.parse(line)).toMatchObject({
    level: 'info',
    event: 'listening',
    host: '127.0.0.1',
    port,
    build: 'development',
    writes: 'open',
  });
  expect(stdout + stderr).not.toContain(secret);
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ ok: true, dbWritable: true });
  const missing = await fetch(`http://127.0.0.1:${port}/api/nope`);
  expect(missing.status).toBe(401);
  child.kill('SIGTERM');
  await new Promise((r) => child.once('exit', r));
});
