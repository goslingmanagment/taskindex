import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A real CLI process against a local HTTP fixture: the pipe consumer closes
// early, as `taskindex tasks --all | head -c 1` does.
let server: Server;
let baseUrl = '';
const PAGES = 400;

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/me') {
      response.end(
        JSON.stringify({
          id: 'agent:test',
          agentId: 'test',
          label: 'Тест',
          kind: 'agent',
          scope: 'read',
        }),
      );
      return;
    }
    if (url.pathname === '/api/tasks') {
      const page = Number(url.searchParams.get('cursor') ?? '0');
      response.end(
        JSON.stringify({
          generation: 'g1',
          seq: 0,
          items: [{ id: `t${page}`, note: 'x'.repeat(4000) }],
          more: page + 1 < PAGES,
          nextCursor: page + 1 < PAGES ? String(page + 1) : null,
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(
      JSON.stringify({ ok: false, code: 'not_found', retryable: false }),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('fixture server has no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('CLI process and a closed stdout', () => {
  it('TI-050: exits quietly with code 0 when the pipe consumer stops reading', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskindex-process-'));
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli/index.ts', 'tasks', '--all', '--limit', '1'],
      {
        env: {
          ...process.env,
          TASKINDEX_URL: baseUrl,
          TASKINDEX_TOKEN: 'local-test-token',
          XDG_STATE_HOME: directory,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    let received = 0;
    child.stdout.once('data', (chunk: Buffer) => {
      received = chunk.length;
      // The consumer goes away after the first chunk, like `head -c 1`.
      child.stdout.destroy();
    });
    const code = await new Promise<number | null>((resolve) =>
      child.on('exit', (exitCode) => resolve(exitCode)),
    );
    expect(received).toBeGreaterThan(0);
    expect(stderr).toBe('');
    expect(code).toBe(0);
  }, 30_000);
});
