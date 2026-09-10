import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { Outbox } from '../../src/cli/outbox.js';

function requestUrl(value: string | URL | Request): URL {
  return new URL(value instanceof Request ? value.url : value.toString());
}

function requestBody(init?: RequestInit): string {
  if (typeof init?.body !== 'string')
    throw new Error('Expected a JSON request body');
  return init.body;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function setup(
  handler: (url: URL, init?: RequestInit) => Promise<Response> | Response,
) {
  const directory = await mkdtemp(join(tmpdir(), 'taskindex-cli-'));
  const env = {
    TASKINDEX_URL: 'https://taskindex.example',
    TASKINDEX_TOKEN: 'secret-test-token',
    XDG_STATE_HOME: directory,
  };
  const output: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const requestFetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => handler(requestUrl(url), init)) as typeof fetch;
  return {
    directory,
    env,
    output,
    errors,
    outbox: new Outbox(env),
    run: (argv: string[]) =>
      runCli(argv, {
        env,
        fetch: requestFetch,
        stdout: (line) =>
          output.push(JSON.parse(line) as Record<string, unknown>),
        stderr: (line) => errors.push(line),
        sleep: async () => undefined,
      }),
  };
}

describe('CLI durable operations', () => {
  it('requires the saved generation with a nonzero event cursor', async () => {
    let requests = 0;
    const test = await setup(() => {
      requests += 1;
      return json({ generation: 'g_new', events: [], more: false });
    });
    expect(await test.run(['events', '--since', '42'])).toBe(2);
    expect(requests).toBe(0);
    expect(
      await test.run(['events', '--since', '42', '--generation', 'g_old']),
    ).toBe(0);
  });

  it('retains the operation id when status lookup also loses its connection', async () => {
    const test = await setup((url) => {
      if (url.pathname === '/api/context')
        return json({ generation: 'g_first' });
      throw new TypeError('network down');
    });
    await test.run([
      'comment',
      'add',
      't1',
      '--text',
      'Отчёт',
      '--operation-id',
      'lost-status',
    ]);
    expect(await test.run(['operation', 'get', 'lost-status'])).toBe(1);
    expect(test.output.at(-1)).toMatchObject({
      operationId: 'lost-status',
      status: 'unknown',
    });
    expect(await test.run(['operation', 'resume', 'lost-status'])).toBe(1);
    expect(test.output.at(-1)).toMatchObject({
      operationId: 'lost-status',
      status: 'unknown',
    });
    expect(await test.outbox.get('lost-status')).toBeDefined();
  });

  it('persists before POST, retries the identical envelope and removes only after confirmation', async () => {
    const bodies: string[] = [];
    const test = await setup(async (url, init) => {
      if (url.pathname === '/api/context')
        return json({ generation: 'g_first' });
      const body = requestBody(init);
      bodies.push(body);
      const saved = JSON.parse(
        await readFile(
          join(test.directory, 'taskindex', 'ops', 'op1.json'),
          'utf8',
        ),
      );
      expect(saved.envelope).toEqual(JSON.parse(body));
      expect(JSON.stringify(saved)).not.toContain('secret-test-token');
      expect(
        (await stat(join(test.directory, 'taskindex', 'ops', 'op1.json')))
          .mode & 0o777,
      ).toBe(0o600);
      if (bodies.length === 1)
        throw new TypeError('connection reset after commit');
      return json({
        ok: true,
        operationId: 'op1',
        results: [{ record: { id: 'task1' } }],
        events: [],
      });
    });
    expect(
      await test.run([
        'task',
        'create',
        '--area',
        'agency',
        '--title',
        'Проверить',
        '--operation-id',
        'op1',
      ]),
    ).toBe(0);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(await test.outbox.get('op1')).toBeUndefined();
    expect(test.output.at(-1)?.ok).toBe(true);
  });

  it('keeps a held operation after all retryable 503 responses, then resumes after open-writes', async () => {
    let held = true;
    const bodies: unknown[] = [];
    const test = await setup((url, init) => {
      if (url.pathname === '/api/context')
        return json({ generation: 'g_first' });
      if (url.pathname.startsWith('/api/operations/'))
        return json({ ok: false, code: 'not_found', retryable: false }, 404);
      bodies.push(JSON.parse(requestBody(init)));
      return held
        ? json({ ok: false, code: 'unavailable', retryable: true }, 503)
        : json({ ok: true, results: [], events: [] });
    });
    expect(
      await test.run([
        'task',
        'archive',
        't1',
        '--base-revision',
        '3',
        '--operation-id',
        'op2',
      ]),
    ).toBe(1);
    expect(bodies).toHaveLength(4);
    expect(test.output.at(-1)).toMatchObject({
      code: 'unavailable',
      operationId: 'op2',
      retryable: true,
    });
    expect(await test.outbox.get('op2')).toBeDefined();
    held = false;
    expect(await test.run(['operation', 'resume', 'op2'])).toBe(0);
    expect(bodies.at(-1)).toEqual(bodies[0]);
    expect(await test.outbox.get('op2')).toBeUndefined();
  });

  it('reports unknown network outcome and resolves a previously committed result without another POST', async () => {
    let resolve = false;
    let posts = 0;
    const test = await setup((url) => {
      if (url.pathname === '/api/context')
        return json({ generation: 'g_first' });
      if (resolve)
        return json({
          status: 200,
          result: { ok: true, operationId: 'op3', results: [], events: [] },
        });
      posts += 1;
      throw new TypeError('disconnected');
    });
    expect(
      await test.run([
        'comment',
        'add',
        't1',
        '--text',
        'Отчёт',
        '--operation-id',
        'op3',
      ]),
    ).toBe(1);
    expect(test.output.at(-1)).toMatchObject({
      status: 'unknown',
      operationId: 'op3',
    });
    expect(await test.outbox.get('op3')).toBeDefined();
    resolve = true;
    expect(await test.run(['operation', 'resume', 'op3'])).toBe(0);
    expect(posts).toBe(4);
    expect(await test.outbox.get('op3')).toBeUndefined();
  });

  it('does not silently change a saved generation or overwrite an existing operation', async () => {
    const sent: Record<string, unknown>[] = [];
    let generation = 'g_old';
    const test = await setup((url, init) => {
      if (url.pathname === '/api/context') return json({ generation });
      if (url.pathname.startsWith('/api/operations/'))
        return json({ ok: false, code: 'not_found', retryable: false }, 404);
      const body = JSON.parse(requestBody(init)) as Record<string, unknown>;
      sent.push(body);
      if (generation === 'g_old') throw new TypeError('network');
      return json(
        { ok: false, code: 'generation_changed', retryable: false },
        409,
      );
    });
    await test.run([
      'task',
      'create',
      '--area',
      'agency',
      '--title',
      'Исходная',
      '--operation-id',
      'op4',
    ]);
    expect(
      await test.run([
        'task',
        'create',
        '--area',
        'agency',
        '--title',
        'Подмена',
        '--operation-id',
        'op4',
      ]),
    ).toBe(2);
    expect(sent).toHaveLength(4);
    generation = 'g_new';
    expect(await test.run(['operation', 'resume', 'op4'])).toBe(3);
    expect(sent.at(-1)?.generation).toBe('g_old');
    expect(await test.outbox.get('op4')).toBeUndefined();
  });

  it('returns current on conflict, removes the terminal envelope and maps authorization exit codes', async () => {
    let status = 409;
    const test = await setup((url) =>
      url.pathname === '/api/context'
        ? json({ generation: 'g_first' })
        : json(
            {
              ok: false,
              code: status === 409 ? 'conflict' : 'forbidden',
              retryable: false,
              current: { revision: 8 },
            },
            status,
          ),
    );
    expect(
      await test.run([
        'task',
        'update',
        't1',
        '--base-revision',
        '1',
        '--title',
        'Правка',
        '--operation-id',
        'op5',
      ]),
    ).toBe(3);
    expect(test.output.at(-1)?.current).toEqual({ revision: 8 });
    expect(await test.outbox.get('op5')).toBeUndefined();
    status = 403;
    expect(
      await test.run(['task', 'archive', 't1', '--base-revision', '8']),
    ).toBe(4);
  });

  it('supports atomic batch files and does not reinterpret the command payload', async () => {
    let sent: Record<string, unknown> | undefined;
    const test = await setup((url, init) => {
      if (url.pathname === '/api/context')
        return json({ generation: 'g_first' });
      expect(url.pathname).toBe('/api/commands/batch');
      sent = JSON.parse(requestBody(init));
      return json({ ok: true, results: [], events: [] });
    });
    const commands = [
      {
        command: 'task.sync',
        payload: {
          origin: { system: 'telegram', ref: '42' },
          fields: { area: 'agency', title: 'Источник без версии' },
        },
      },
    ];
    const code = await runCli(['batch', '--file', '-', '--dry-run'], {
      env: test.env,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = requestUrl(url);
        if (u.pathname === '/api/context')
          return json({ generation: 'g_first' });
        sent = JSON.parse(requestBody(init));
        return json({ ok: true, results: [], events: [] });
      }) as typeof fetch,
      readInput: async () => JSON.stringify(commands),
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(sent).toMatchObject({
      commands,
      dryRun: true,
      generation: 'g_first',
    });
    expect(await readdir(test.outbox.directory)).toEqual([]);
  });

  it('follows every tasks page explicitly and carries the generation with its cursor', async () => {
    const urls: URL[] = [];
    const test = await setup((url) => {
      urls.push(url);
      return url.searchParams.has('cursor')
        ? json({
            generation: 'g_first',
            items: [{ id: 'b' }],
            more: false,
            nextCursor: null,
          })
        : json({
            generation: 'g_first',
            items: [{ id: 'a' }],
            more: true,
            nextCursor: 'opaque',
          });
    });
    expect(await test.run(['tasks', '--all', '--limit', '1'])).toBe(0);
    expect(test.output).toHaveLength(2);
    expect(urls[1]?.searchParams.get('cursor')).toBe('opaque');
    expect(urls[1]?.searchParams.get('generation')).toBe('g_first');
  });
});
