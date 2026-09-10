import { afterEach, it, expect } from 'vitest';
import { openDatabase, migrate, generation } from '../../src/server/db.js';
import { createApp } from '../../src/server/app.js';
import type { AppOptions } from '../../src/server/app.js';
import { createLogger } from '../../src/server/log.js';
import type { LogLevel } from '../../src/server/log.js';
import { createEventHub } from '../../src/server/sse.js';
import { agent, owner } from './helpers.js';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
type Line = Record<string, unknown> & { level: string; time: string };
function setup(level: LogLevel, options: Partial<AppOptions> = {}) {
  const db = openDatabase(':memory:');
  migrate(db);
  const out: Line[] = [];
  const err: Line[] = [];
  const raw: string[] = [];
  const parse = (into: Line[]) => (line: string) => {
    raw.push(line);
    into.push(JSON.parse(line) as Line);
  };
  const logger = createLogger(level, { out: parse(out), err: parse(err) });
  const app = createApp({
    db,
    logger,
    authorize: (r) =>
      r.headers.get('x-test-role') === 'read'
        ? { ...agent, scope: 'read' }
        : owner,
    ...options,
  });
  cleanup.push(() => {
    app.closeStreams();
    db.close();
  });
  const command = (
    title: string,
    headers: Record<string, string> = {},
    id = title.toLowerCase(),
  ) =>
    app.request('/api/commands', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:5173',
        ...headers,
      },
      body: JSON.stringify({
        command: 'task.create',
        payload: { id, area: 'agency', title },
        operationId: `op-${id}`,
        generation: generation(db),
      }),
    });
  return { db, app, out, err, raw, command };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
it('answers an unexpected error with 500 internal (final) and logs one stderr line with message, stack and the response request id', async () => {
  const f = setup('info', {
    authorize: () => {
      throw new TypeError('boom');
    },
  });
  const response = await f.app.request('/api/me', {
    headers: { authorization: 'Bearer secret-token-value' },
  });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    ok: false,
    code: 'internal',
    message: 'Внутренняя ошибка сервера. Операция не выполнена.',
    retryable: false,
  });
  const requestId = response.headers.get('x-request-id')!;
  expect(requestId).toMatch(uuid);
  expect(f.out).toEqual([]);
  expect(f.err).toHaveLength(2);
  expect(f.err.map((l) => l.event)).toEqual(
    expect.arrayContaining(['internal_error', 'request']),
  );
  const error = f.err.find((l) => l.event === 'internal_error')!;
  const request = f.err.find((l) => l.event === 'request')!;
  expect(error).toMatchObject({
    level: 'error',
    event: 'internal_error',
    requestId,
    method: 'GET',
    path: '/api/me',
    error: 'TypeError',
    message: 'boom',
  });
  expect(String(error.stack)).toContain('TypeError: boom');
  expect(Object.keys(error)[0]).toBe('level');
  expect(request).toMatchObject({ event: 'request', requestId, code: 500 });
  expect(f.raw.join('\n')).not.toContain('secret-token-value');
});
it('keeps SQLite availability errors retryable and makes other driver errors final; secrets and task text stay out of logs and the response', async () => {
  const busy = setup('info', {
    authorize: () => {
      throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    },
  });
  const unavailable = await busy.app.request('/api/me');
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toMatchObject({
    code: 'unavailable',
    retryable: true,
  });
  expect(busy.err.filter((l) => l.level === 'error')).toEqual([]);
  const constraint = setup('info', {
    authorize: () => {
      throw Object.assign(new Error('constraint failed'), {
        code: 'SQLITE_CONSTRAINT',
        cause: new RangeError('inner'),
      });
    },
  });
  const final = await constraint.app.request('/api/me');
  expect(final.status).toBe(500);
  expect(await final.json()).toMatchObject({
    code: 'internal',
    retryable: false,
  });
  expect(
    constraint.err.find((l) => l.event === 'internal_error'),
  ).toMatchObject({
    event: 'internal_error',
    code: 'SQLITE_CONSTRAINT',
    message: 'constraint failed',
    cause: 'RangeError: inner',
  });
  const inside = setup('info', {
    now: () => {
      throw new TypeError('clock broken');
    },
  });
  const response = await inside.command(
    'SECRET-TASK-TEXT',
    { cookie: 'session=secret-cookie-value', 'x-request-id': 'req-42' },
    'inside',
  );
  expect(response.status).toBe(500);
  const text = await response.text();
  expect(text).not.toContain('SECRET-TASK-TEXT');
  expect(text).not.toContain('clock broken');
  expect(inside.err.filter((l) => l.level === 'error')).toHaveLength(1);
  expect(inside.err.find((l) => l.event === 'internal_error')).toMatchObject({
    event: 'internal_error',
    requestId: 'req-42',
    operationId: 'op-inside',
    command: 'task.create',
    actor: 'owner',
    message: 'clock broken',
  });
  expect(inside.raw.join('\n')).not.toContain('SECRET-TASK-TEXT');
  expect(inside.raw.join('\n')).not.toContain('secret-cookie-value');
  expect(
    inside.db.sqlite.prepare('SELECT count(*) AS n FROM operations').get(),
  ).toEqual({ n: 0 });
});
it('echoes a valid x-request-id, replaces invalid ones, and filters request lines by LOG_LEVEL', async () => {
  const debug = setup('debug');
  const echoed = await debug.app.request('/api/snapshot', {
    headers: { 'x-request-id': 'abc' },
  });
  expect(echoed.headers.get('x-request-id')).toBe('abc');
  const generated = await debug.app.request('/api/snapshot');
  expect(generated.headers.get('x-request-id')).toMatch(uuid);
  const replaced = await debug.app.request('/api/snapshot', {
    headers: { 'x-request-id': 'bad id with spaces' },
  });
  expect(replaced.headers.get('x-request-id')).toMatch(uuid);
  const long = await debug.app.request('/api/snapshot', {
    headers: { 'x-request-id': 'x'.repeat(129) },
  });
  expect(long.headers.get('x-request-id')).toMatch(uuid);
  expect(debug.out.map((l) => [l.event, l.path, l.requestId, l.code])).toEqual([
    ['request', '/api/snapshot', 'abc', 200],
    ['request', '/api/snapshot', generated.headers.get('x-request-id'), 200],
    ['request', '/api/snapshot', replaced.headers.get('x-request-id'), 200],
    ['request', '/api/snapshot', long.headers.get('x-request-id'), 200],
  ]);
  const stream = await debug.app.request(
    `/api/events/stream?generation=${generation(debug.db)}`,
    {
      headers: { 'x-request-id': 'stream-1' },
    },
  );
  expect(stream.headers.get('x-request-id')).toBe('stream-1');
  await stream.body?.cancel();
  const info = setup('info');
  expect((await info.app.request('/api/snapshot')).status).toBe(200);
  expect(info.out).toEqual([]);
  const ok = await info.command('Alpha', { 'x-request-id': 'cmd-1' });
  expect(ok.status).toBe(200);
  expect(info.out).toEqual([
    expect.objectContaining({
      level: 'info',
      event: 'request',
      requestId: 'cmd-1',
      operationId: 'op-alpha',
      command: 'task.create',
      actor: 'owner',
      code: 200,
      durationMs: expect.any(Number),
    }),
  ]);
  const warn = setup('warn');
  expect((await warn.command('Beta')).status).toBe(200);
  expect(warn.out).toEqual([]);
  expect(warn.err).toEqual([]);
  const forbidden = await warn.command('Gamma', { 'x-test-role': 'read' });
  expect(forbidden.status).toBe(403);
  expect(warn.err).toEqual([
    expect.objectContaining({
      level: 'warn',
      event: 'request',
      code: 403,
      actor: 'agent:test-agent',
    }),
  ]);
});
it('logs a failure after commit as post_commit_error and still returns the stored result', async () => {
  const hub = createEventHub();
  const f = setup('info', {
    hub: {
      ...hub,
      publish: () => {
        throw new Error('fan-out exploded');
      },
    },
  });
  const response = await f.command('Delta', { 'x-request-id': 'post-1' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    operationId: 'op-delta',
  });
  expect(f.err.filter((l) => l.level === 'error')).toEqual([
    expect.objectContaining({
      event: 'post_commit_error',
      requestId: 'post-1',
      operationId: 'op-delta',
      message: 'fan-out exploded',
    }),
  ]);
  const stored = await f.app.request('/api/operations/op-delta');
  expect(stored.status).toBe(200);
  expect(await stored.json()).toMatchObject({ id: 'op-delta', ok: true });
});
it('reports dbWritable: false with 503 when the database refuses writes', async () => {
  const f = setup('info');
  expect(await (await f.app.request('/health')).json()).toMatchObject({
    ok: true,
    dbWritable: true,
  });
  f.db.sqlite.pragma('query_only = ON');
  const readonly = await f.app.request('/health');
  expect(readonly.status).toBe(503);
  expect(await readonly.json()).toMatchObject({
    ok: false,
    dbWritable: false,
    writes: 'open',
  });
  f.db.sqlite.pragma('query_only = OFF');
  expect((await f.app.request('/health')).status).toBe(200);
});
