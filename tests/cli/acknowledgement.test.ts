import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { Outbox } from '../../src/cli/outbox.js';
import { statePaths } from '../../src/cli/state.js';

const actor = {
  id: 'agent:test',
  agentId: 'test',
  label: 'Тест',
  kind: 'agent',
  scope: 'write',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Handler = (
  request: Request,
  envelope: Record<string, unknown> | undefined,
) => Promise<Response> | Response;

async function setup(handler: Handler) {
  const directory = await mkdtemp(join(tmpdir(), 'taskindex-ack-'));
  const env = {
    TASKINDEX_URL: 'https://taskindex.example',
    TASKINDEX_TOKEN: 'secret-test-token',
    XDG_STATE_HOME: directory,
  };
  const output: Record<string, unknown>[] = [];
  const posts: Record<string, unknown>[] = [];
  const requestFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/api/me') return json(actor);
    if (url.pathname === '/api/context') return json({ generation: 'g1' });
    const envelope =
      request.method === 'POST'
        ? ((await request.json()) as Record<string, unknown>)
        : undefined;
    if (envelope) posts.push(envelope);
    return handler(request, envelope);
  }) as typeof fetch;
  return {
    env,
    output,
    posts,
    outbox: new Outbox(statePaths(env, env.TASKINDEX_URL).ops('test')),
    run: (argv: string[]) =>
      runCli(argv, {
        env,
        fetch: requestFetch,
        stdout: (line) =>
          output.push(JSON.parse(line) as Record<string, unknown>),
        stderr: () => undefined,
        sleep: async () => undefined,
      }),
  };
}

const create = (id: string) => [
  'task',
  'create',
  '--area',
  'agency',
  '--title',
  'Проверить',
  '--operation-id',
  id,
];

const success = (operationId: string, generation = 'g1') => ({
  ok: true,
  operationId,
  generation,
  firstSeq: 1,
  lastSeq: 1,
  results: [{ record: null, changes: {} }],
  events: [],
});

describe('CLI removes an envelope only after a verified outcome of that operation', () => {
  it.each([
    ['HTTP 200 maintenance page', { status: 'maintenance' }],
    ['empty JSON object', {}],
    ['success of another operation', success('someone-else')],
    ['success of another generation', success('op1', 'g_other')],
    ['unknown discriminant', { ok: 'yes', operationId: 'op1' }],
  ])(
    'keeps the envelope and exits 1 with invalid_response on %s',
    async (_name, body) => {
      const test = await setup(() => json(body));
      expect(await test.run(create('op1'))).toBe(1);
      expect(test.output.at(-1)).toMatchObject({
        ok: false,
        code: 'invalid_response',
        status: 'unknown',
        operationId: 'op1',
        retryable: true,
      });
      expect(test.posts).toHaveLength(1);
      expect(await test.outbox.get('op1')).toBeDefined();
    },
  );

  it('confirms a real success even when the server adds fields, and removes the envelope', async () => {
    const test = await setup((_request, envelope) =>
      json({
        ...success(String(envelope?.operationId)),
        results: [{ record: { id: 't1', futureField: 1 }, changes: {} }],
        futureTopLevel: true,
      }),
    );
    expect(await test.run(create('op2'))).toBe(0);
    expect(test.output.at(-1)).toMatchObject({ ok: true, operationId: 'op2' });
    expect(await test.outbox.get('op2')).toBeUndefined();
  });

  it('treats a definitive rejection as final: envelope removed, exit code by kind', async () => {
    const conflict = await setup(() =>
      json(
        {
          ok: false,
          code: 'conflict',
          message: 'Запись изменилась',
          retryable: false,
          current: { revision: 8 },
          issues: [],
        },
        409,
      ),
    );
    expect(await conflict.run(create('op3'))).toBe(3);
    expect(await conflict.outbox.get('op3')).toBeUndefined();
    const forbidden = await setup(() =>
      json(
        { ok: false, code: 'forbidden', message: 'Нет', retryable: false },
        403,
      ),
    );
    expect(await forbidden.run(create('op4'))).toBe(4);
    expect(await forbidden.outbox.get('op4')).toBeUndefined();
    const invalid = await setup(() =>
      json(
        { ok: false, code: 'invalid', message: 'Нет', retryable: false },
        400,
      ),
    );
    expect(await invalid.run(create('op5'))).toBe(1);
    expect(await invalid.outbox.get('op5')).toBeUndefined();
  });

  it('keeps retrying a retryable rejection and holds the envelope afterwards', async () => {
    const test = await setup(() =>
      json(
        { ok: false, code: 'unavailable', message: 'Закрыто', retryable: true },
        503,
      ),
    );
    expect(await test.run(create('op6'))).toBe(1);
    expect(test.posts).toHaveLength(4);
    expect(test.output.at(-1)).toMatchObject({
      code: 'unavailable',
      retryable: true,
      operationId: 'op6',
    });
    expect(await test.outbox.get('op6')).toBeDefined();
  });

  it('resume: an unrecognised stored-operation body keeps the envelope and does not resend', async () => {
    let stored: unknown = { status: 'maintenance' };
    const test = await setup((request) => {
      if (request.method === 'POST') throw new TypeError('network');
      return json(stored);
    });
    expect(await test.run(create('op7'))).toBe(1);
    expect(test.posts).toHaveLength(4);
    expect(await test.run(['operation', 'resume', 'op7'])).toBe(1);
    expect(test.output.at(-1)).toMatchObject({
      code: 'invalid_response',
      status: 'unknown',
      operationId: 'op7',
    });
    expect(test.posts).toHaveLength(4);
    expect(await test.outbox.get('op7')).toBeDefined();
    stored = {
      id: 'op7',
      status: 200,
      ok: true,
      actorId: 'agent:test',
      actorLabel: 'Тест',
      command: 'task.create',
      createdAt: '2026-09-10T10:00:00.000Z',
      taskCount: 1,
      titles: ['Проверить'],
      firstSeq: 1,
      lastSeq: 1,
      result: success('op7'),
    };
    expect(await test.run(['operation', 'resume', 'op7'])).toBe(0);
    expect(test.output.at(-1)).toEqual(success('op7'));
    expect(test.posts).toHaveLength(4);
    expect(await test.outbox.get('op7')).toBeUndefined();
  });

  it('resume and get: a stored rejection of this operation closes the envelope with its exit code', async () => {
    const rejection = {
      ok: false,
      code: 'generation_changed',
      message: 'База восстановлена',
      retryable: false,
      operationId: 'op8',
      generation: 'g2',
    };
    const test = await setup((request) => {
      if (request.method === 'POST') throw new TypeError('network');
      return json({
        id: 'op8',
        status: 409,
        ok: false,
        errorCode: 'generation_changed',
        actorId: 'agent:test',
        actorLabel: 'Тест',
        command: 'task.create',
        createdAt: '2026-09-10T10:00:00.000Z',
        taskCount: 0,
        titles: [],
        firstSeq: null,
        lastSeq: null,
        result: rejection,
      });
    });
    await test.run(create('op8'));
    expect(await test.outbox.get('op8')).toBeDefined();
    expect(await test.run(['operation', 'resume', 'op8'])).toBe(3);
    // The stored rejection is printed as it is, plus the CLI's hint on a
    // changed generation.
    expect(test.output.at(-1)).toEqual({
      ...rejection,
      hint: expect.stringContaining('cursor reset') as string,
    });
    expect(await test.outbox.get('op8')).toBeUndefined();

    await test.run(create('op8'));
    expect(await test.outbox.get('op8')).toBeDefined();
    expect(await test.run(['operation', 'get', 'op8'])).toBe(0);
    expect(await test.outbox.get('op8')).toBeUndefined();
  });

  it('get: a stored result of a different operation or generation leaves the envelope alone', async () => {
    const test = await setup((request) => {
      if (request.method === 'POST') throw new TypeError('network');
      return json({
        id: 'op9',
        status: 200,
        ok: true,
        actorId: 'agent:test',
        actorLabel: 'Тест',
        command: 'task.create',
        createdAt: '2026-09-10T10:00:00.000Z',
        taskCount: 1,
        titles: [],
        firstSeq: 1,
        lastSeq: 1,
        result: success('op9', 'g_other'),
      });
    });
    await test.run(create('op9'));
    expect(await test.run(['operation', 'get', 'op9'])).toBe(0);
    expect(await test.outbox.get('op9')).toBeDefined();
  });
});
