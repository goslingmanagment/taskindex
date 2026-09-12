import { afterEach, it, expect } from 'vitest';
import {
  openDatabase,
  migrate,
  generation,
  readState,
} from '../../src/server/db.js';
import { createApp } from '../../src/server/app.js';
import { createAuth } from '../../src/server/auth.js';
import { hashAgentKey } from '../../src/server/agent-keys.js';
import { openWrites } from '../../src/server/deployment.js';
import {
  createOwner,
  resetOwnerPassword,
  createAgent,
  disableAgent,
  createAgentKey,
  revokeAgentKey,
  listAgentKeys,
} from '../../src/server/admin.js';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Reads an SSE response in the background; `ended()` becomes true when the
// server closes the stream.
function tap(response: Response) {
  const chunks: string[] = [];
  let ended = false;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }
  })().finally(() => {
    ended = true;
  });
  return {
    text: () => chunks.join(''),
    ended: () => ended,
    waitEnd: async (ms: number) => {
      await Promise.race([pump, sleep(ms)]);
      return ended;
    },
  };
}
// Better Auth keeps sign-in rate limits in a module-level map keyed by IP, so
// every fixture signs in from its own address.
let fixtures = 0;
async function setup(
  writes: 'open' | 'held' = 'open',
  options: { sseHeartbeatMs?: number } = {},
) {
  const ip = `203.0.113.${++fixtures}`;
  const db = openDatabase(':memory:');
  migrate(db);
  await createOwner(db, {
    email: 'owner@example.test',
    password: 'a-test-password-with-entropy',
  });
  const auth = createAuth(db, {
    baseURL: 'http://localhost:3001',
    trustedOrigins: ['http://localhost:5173'],
    secret: 'test-only-32-character-secret-value-never-used-outside-tests',
  });
  const app = createApp({
    db,
    auth,
    baseURL: 'http://localhost:3001',
    trustedOrigins: ['http://localhost:5173'],
    writes,
    deploymentId: 'test-auth',
    ...options,
  });
  cleanup.push(() => {
    app.closeStreams();
    db.close();
  });
  const signIn = (password = 'a-test-password-with-entropy') =>
    app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:5173',
        'x-real-ip': ip,
        'x-forwarded-for': `198.51.100.20, ${ip}`,
      },
      body: JSON.stringify({ email: 'owner@example.test', password }),
    });
  const cookie = async () =>
    (await signIn()).headers.get('set-cookie')!.split(';')[0]!;
  const changes = () =>
    (db.sqlite.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const stream = (headers: Record<string, string>) =>
    app.request(`/api/events/stream?generation=${generation(db)}`, {
      headers,
    });
  const createTask = (cookie: string, title: string) =>
    app.request('/api/commands', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        command: 'task.create',
        payload: { id: title.toLowerCase(), area: 'agency', title },
        operationId: `create-${title}`,
        generation: generation(db),
      }),
    });
  return { db, auth, app, signIn, cookie, changes, stream, createTask };
}
it('uses real owner sessions, rejects signup and cross-origin writes, exposes authenticated passkey setup', async () => {
  const f = await setup();
  expect((await f.app.request('/api/snapshot')).status).toBe(401);
  const denied = await f.app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:5173',
    },
    body: JSON.stringify({
      name: 'Other',
      email: 'other@example.test',
      password: 'another-password',
    }),
  });
  expect(denied.status).toBeGreaterThanOrEqual(400);
  const login = await f.signIn();
  expect(login.status).toBe(200);
  expect(f.db.sqlite.prepare('SELECT ip_address FROM session').get()).toEqual({
    ip_address: '203.0.113.1',
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  expect(
    await (await f.app.request('/api/me', { headers: { cookie } })).json(),
  ).toMatchObject({ id: 'owner', kind: 'owner' });
  const envelope = {
    command: 'task.create',
    payload: { id: 't', area: 'agency', title: 'T' },
    operationId: 'owner-create',
    generation: generation(f.db),
  };
  expect(
    (
      await f.app.request('/api/commands', {
        method: 'POST',
        headers: {
          cookie,
          origin: 'https://other.test',
          'content-type': 'application/json',
        },
        body: JSON.stringify(envelope),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.app.request('/api/commands', {
        method: 'POST',
        headers: {
          cookie,
          origin: 'http://localhost:5173',
          'content-type': 'application/json',
        },
        body: JSON.stringify(envelope),
      })
    ).status,
  ).toBe(200);
  const options = await f.app.request(
    '/api/auth/passkey/generate-register-options',
    { headers: { cookie, origin: 'http://localhost:5173' } },
  );
  expect(options.status).toBe(200);
  expect(await options.json()).toMatchObject({
    rp: { id: 'localhost', name: 'TaskIndex' },
    challenge: expect.any(String),
  });
  await resetOwnerPassword(f.db, {
    password: 'a-new-test-password-with-entropy',
  });
  expect((await f.app.request('/api/me', { headers: { cookie } })).status).toBe(
    401,
  );
  expect((await f.signIn()).status).toBe(401);
  expect((await f.signIn('a-new-test-password-with-entropy')).status).toBe(200);
});
it('rotates hashed agent keys with stable actors, enforces scopes, revocation and agent disabling', async () => {
  const f = await setup();
  createAgent(f.db, { id: 'worker', label: 'Worker' });
  const first = createAgentKey(f.db, { agentId: 'worker', scope: 'tasks' });
  const second = createAgentKey(f.db, { agentId: 'worker', scope: 'tasks' });
  const read = createAgentKey(f.db, { agentId: 'worker', scope: 'read' });
  expect(first.key.startsWith('ti_')).toBe(true);
  const me = async (key: string) =>
    f.app.request('/api/me', { headers: { authorization: `Bearer ${key}` } });
  expect(await (await me(first.key)).json()).toMatchObject({
    id: 'agent:worker',
    scope: 'tasks',
  });
  expect(await (await me(second.key)).json()).toMatchObject({
    id: 'agent:worker',
  });
  expect(JSON.stringify(listAgentKeys(f.db))).not.toContain(first.key);
  expect(
    f.db.sqlite
      .prepare('SELECT key_hash FROM agent_keys WHERE id=?')
      .get(first.id),
  ).toEqual({ key_hash: hashAgentKey(first.key) });
  expect(hashAgentKey(first.key)).not.toBe(first.key);
  const command = async (key: string, name: 'task.create' | 'project.create') =>
    f.app.request('/api/commands', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        command: name,
        payload:
          name === 'task.create'
            ? { id: 'task', area: 'agency', title: 'T' }
            : { area: 'agency', name: 'P', color: '#112233' },
        operationId: `${name.replace('.', '-')}-${key.slice(-5)}`,
        generation: generation(f.db),
      }),
    });
  expect((await command(first.key, 'project.create')).status).toBe(403);
  expect((await command(read.key, 'task.create')).status).toBe(403);
  expect((await command(first.key, 'task.create')).status).toBe(200);
  expect(readState(f.db).tasks[0]!.createdBy).toBe('agent:worker');
  revokeAgentKey(f.db, first.id);
  expect((await me(first.key)).status).toBe(403);
  expect((await me(second.key)).status).toBe(200);
  disableAgent(f.db, 'worker');
  expect((await me(second.key)).status).toBe(403);
});
it('held blocks authentication mutations as well as workspace mutations', async () => {
  const f = await setup('held');
  expect((await f.signIn()).status).toBe(503);
  expect((await f.app.request('/health')).status).toBe(200);
});
it('checks agent keys without writing to the database, also under held and across SSE heartbeats', async () => {
  for (const mode of ['open', 'held'] as const) {
    const f = await setup(mode, { sseHeartbeatMs: 20 });
    createAgent(f.db, { id: 'worker', label: 'Worker' });
    const key = createAgentKey(f.db, { agentId: 'worker', scope: 'tasks' });
    const headers = { authorization: `Bearer ${key.key}` };
    const n0 = f.changes();
    for (let i = 0; i < 5; i++)
      expect((await f.app.request('/api/me', { headers })).status).toBe(200);
    for (let i = 0; i < 3; i++)
      expect((await f.app.request('/api/tasks', { headers })).status).toBe(200);
    expect(f.changes()).toBe(n0);
    const write = await f.app.request('/api/commands', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        command: 'task.create',
        payload: { id: 't', area: 'agency', title: 'T' },
        operationId: `held-${mode}`,
        generation: generation(f.db),
      }),
    });
    expect(write.status).toBe(mode === 'held' ? 503 : 200);
    if (mode === 'held') expect(f.changes()).toBe(n0);
    const n1 = f.changes();
    const t = tap(await f.stream(headers));
    await sleep(100);
    expect(t.ended()).toBe(false);
    expect(t.text().split(': heartbeat').length).toBeGreaterThan(3);
    expect(f.changes()).toBe(n1);
    revokeAgentKey(f.db, key.id);
    const n2 = f.changes();
    expect(await t.waitEnd(500)).toBe(true);
    expect(t.text().endsWith('event: revoked\ndata: {}\n\n')).toBe(true);
    expect(f.changes()).toBe(n2);
  }
});
it('keeps agent key management out of HTTP: /api/auth/api-key/* is not found for owner cookies and agent keys', async () => {
  const f = await setup();
  createAgent(f.db, { id: 'worker', label: 'Worker' });
  const key = createAgentKey(f.db, { agentId: 'worker', scope: 'write' });
  const cookie = await f.cookie();
  const n0 = f.changes();
  const credentials: Record<string, string>[] = [
    { cookie, origin: 'http://localhost:5173' },
    { authorization: `Bearer ${key.key}` },
  ];
  for (const headers of credentials) {
    const create = await f.app.request('/api/auth/api-key/create', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(create.status).toBe(404);
    expect(await create.json()).toEqual({
      ok: false,
      code: 'not_found',
      message: 'Ключи агентов выдаются только командой taskindex-admin.',
      retryable: false,
    });
    const list = await f.app.request('/api/auth/api-key/list', { headers });
    expect(list.status).toBe(404);
    expect(await list.json()).toMatchObject({ ok: false, code: 'not_found' });
  }
  expect(f.changes()).toBe(n0);
  expect(listAgentKeys(f.db)).toHaveLength(1);
});
it('stops an open SSE stream after its key is revoked elsewhere: no data after revocation, closed within one heartbeat', async () => {
  const f = await setup('open', { sseHeartbeatMs: 50 });
  createAgent(f.db, { id: 'worker', label: 'Worker' });
  const revoked = createAgentKey(f.db, { agentId: 'worker', scope: 'read' });
  const kept = createAgentKey(f.db, { agentId: 'worker', scope: 'read' });
  const cookie = await f.cookie();
  expect((await f.createTask(cookie, 'Before')).status).toBe(200);
  const doomed = tap(
    await f.stream({ authorization: `Bearer ${revoked.key}` }),
  );
  const alive = tap(await f.stream({ authorization: `Bearer ${kept.key}` }));
  await sleep(20);
  expect(doomed.text()).toContain('"to":"Before"');
  // Revocation happens in another process (admin CLI): only the database changes.
  revokeAgentKey(f.db, revoked.id);
  expect(
    (
      await f.app.request('/api/me', {
        headers: { authorization: `Bearer ${revoked.key}` },
      })
    ).status,
  ).toBe(403);
  expect((await f.createTask(cookie, 'Secret')).status).toBe(200);
  expect(await doomed.waitEnd(500)).toBe(true);
  expect(doomed.text()).not.toContain('Secret');
  expect(doomed.text().endsWith('event: revoked\ndata: {}\n\n')).toBe(true);
  await sleep(120);
  expect(alive.ended()).toBe(false);
  expect(alive.text()).toContain('"to":"Secret"');
  expect(alive.text()).toContain(': heartbeat');
  expect(alive.text()).not.toContain('event: revoked');
});
it('closes idle and active streams when the agent is disabled and the owner stream after sessions are reset', async () => {
  const f = await setup('open', { sseHeartbeatMs: 50 });
  createAgent(f.db, { id: 'worker', label: 'Worker' });
  const key = createAgentKey(f.db, { agentId: 'worker', scope: 'read' });
  const idle = tap(await f.stream({ authorization: `Bearer ${key.key}` }));
  await sleep(20);
  disableAgent(f.db, 'worker');
  expect(await idle.waitEnd(500)).toBe(true);
  expect(idle.text().endsWith('event: revoked\ndata: {}\n\n')).toBe(true);
  const cookie = await f.cookie();
  const ownerStream = tap(await f.stream({ cookie }));
  await sleep(20);
  expect(ownerStream.ended()).toBe(false);
  await resetOwnerPassword(f.db, {
    password: 'a-new-test-password-with-entropy',
  });
  expect((await f.createTask(cookie, 'Secret')).status).toBe(401);
  expect(await ownerStream.waitEnd(500)).toBe(true);
  expect(ownerStream.text()).not.toContain('Secret');
  expect(ownerStream.text().endsWith('event: revoked\ndata: {}\n\n')).toBe(
    true,
  );
});

async function heldOwner(options: { sseHeartbeatMs?: number } = {}) {
  const f = await setup('held', options);
  openWrites(f.db, 'test-auth');
  const cookie = await f.cookie();
  // The admin closes the deployment after the owner has already signed in.
  f.db.sqlite
    .prepare("DELETE FROM settings WHERE key = 'approved_deployment'")
    .run();
  return { ...f, ownerCookie: cookie };
}

function ageSession(f: Awaited<ReturnType<typeof setup>>, expired = false) {
  const day = 86_400_000;
  f.db.sqlite
    .prepare('UPDATE session SET updated_at = ?, expires_at = ?')
    .run(Date.now() - 2 * day, Date.now() + (expired ? -day : 2 * day));
}

it.each(
  ['aged', 'expired'].flatMap((age) =>
    [
      '/api/me',
      '/api/auth/get-session',
      '/api/auth/get-session?disableRefresh=true',
      '/api/commands',
    ].map((path) => ({ age, path })),
  ),
)(
  'keeps $age owner sessions unchanged while held: $path',
  async ({ age, path }) => {
    const f = await heldOwner();
    const expired = age === 'expired';
    ageSession(f, expired);
    const before = f.db.sqlite.prepare('SELECT * FROM session').all();
    const n = f.changes();
    const response =
      path === '/api/commands'
        ? await f.createTask(f.ownerCookie, 'Held')
        : await f.app.request(path, { headers: { cookie: f.ownerCookie } });
    if (path.startsWith('/api/auth/')) {
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('pragma')).toBe('no-cache');
      const body = await response.json();
      if (expired) expect(body).toBeNull();
      else expect(body).toMatchObject({ user: { id: 'owner' } });
    } else if (expired) {
      expect(response.status).toBe(401);
    } else if (path === '/api/commands') {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: 'unavailable',
        retryable: true,
      });
    } else {
      expect(response.status).toBe(200);
    }
    expect(f.changes()).toBe(n);
    expect(f.db.sqlite.prepare('SELECT * FROM session').all()).toEqual(before);
    expect(readState(f.db).tasks).toHaveLength(0);
  },
);

it.each([
  '/api/auth/passkey/generate-register-options',
  '/api/auth/passkey/generate-authenticate-options',
])('holds auth GETs that can create verification records: %s', async (path) => {
  const f = await heldOwner();
  const n = f.changes();
  const response = await f.app.request(path, {
    headers: { cookie: f.ownerCookie, origin: 'http://localhost:5173' },
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: 'unavailable',
    retryable: true,
  });
  expect(f.changes()).toBe(n);
  expect(f.db.sqlite.prepare('SELECT * FROM verification').all()).toEqual([]);
  const head = await f.app.request(path, {
    method: 'HEAD',
    headers: { cookie: f.ownerCookie, origin: 'http://localhost:5173' },
  });
  expect(head.status).toBe(503);
  expect(await head.text()).toBe('');
  expect(f.changes()).toBe(n);
});

it('does not allow refresh query flags or POST get-session to bypass held writes', async () => {
  const f = await heldOwner();
  ageSession(f);
  const n = f.changes();
  const headers = { cookie: f.ownerCookie, origin: 'http://localhost:5173' };
  const read = await f.app.request(
    '/api/auth/get-session?disableRefresh=false&updateSession=true',
    { headers },
  );
  expect(read.status).toBe(200);
  expect(f.changes()).toBe(n);
  const post = await f.app.request('/api/auth/get-session', {
    method: 'POST',
    headers,
  });
  expect(post.status).toBe(503);
  expect(f.changes()).toBe(n);
});

it.each(['aged', 'expired'])(
  'keeps HEAD session inspection read-only for %s sessions while held',
  async (age) => {
    const f = await heldOwner();
    ageSession(f, age === 'expired');
    const n = f.changes();
    const response = await f.app.request('/api/auth/get-session', {
      method: 'HEAD',
      headers: { cookie: f.ownerCookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
    expect(f.changes()).toBe(n);
  },
);

it('checks signed cookies and current revocation state during held session reads', async () => {
  const f = await heldOwner();
  const cookie = f.ownerCookie;
  const tampered = cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A');
  const getSession = (requestCookie: string) =>
    f.app.request('/api/auth/get-session', {
      headers: { cookie: requestCookie },
    });
  expect(await (await getSession(cookie)).json()).toMatchObject({
    user: { id: 'owner' },
  });
  const n = f.changes();
  const invalid = await getSession(tampered);
  expect(invalid.status).toBe(200);
  expect(invalid.headers.get('cache-control')).toBe('no-store');
  expect(await invalid.json()).toBeNull();
  expect(
    (await f.app.request('/api/me', { headers: { cookie: tampered } })).status,
  ).toBe(401);
  expect(f.changes()).toBe(n);
  f.db.sqlite.prepare('DELETE FROM session').run();
  const afterRevoke = f.changes();
  expect(await (await getSession(cookie)).json()).toBeNull();
  expect((await f.app.request('/api/me', { headers: { cookie } })).status).toBe(
    401,
  );
  expect(f.changes()).toBe(afterRevoke);
});

it('keeps aged owner SSE admission and heartbeats read-only while held', async () => {
  const f = await heldOwner({ sseHeartbeatMs: 20 });
  ageSession(f);
  const n = f.changes();
  const response = await f.stream({ cookie: f.ownerCookie });
  expect(response.status).toBe(200);
  const t = tap(response);
  await sleep(80);
  expect(t.ended()).toBe(false);
  expect(t.text()).toContain(': heartbeat');
  expect(f.changes()).toBe(n);
});

it.each(['open', 'held'] as const)(
  'revokes an expired owner SSE session without cleanup writes in %s mode',
  async (mode) => {
    const f = await heldOwner({ sseHeartbeatMs: 20 });
    if (mode === 'open') openWrites(f.db, 'test-auth');
    const response = await f.stream({ cookie: f.ownerCookie });
    expect(response.status).toBe(200);
    const t = tap(response);
    ageSession(f, true);
    const before = f.db.sqlite.prepare('SELECT * FROM session').all();
    const n = f.changes();
    expect(await t.waitEnd(500)).toBe(true);
    expect(t.text().endsWith('event: revoked\ndata: {}\n\n')).toBe(true);
    expect(f.changes()).toBe(n);
    expect(f.db.sqlite.prepare('SELECT * FROM session').all()).toEqual(before);
  },
);

it('resumes normal owner refresh, commands and expired-session cleanup after open-writes', async () => {
  const f = await heldOwner();
  ageSession(f);
  const before = f.db.sqlite
    .prepare('SELECT updated_at, expires_at FROM session')
    .get();
  openWrites(f.db, 'test-auth');
  const response = await f.app.request('/api/auth/get-session', {
    headers: { cookie: f.ownerCookie },
  });
  expect(response.status).toBe(200);
  expect(
    f.db.sqlite.prepare('SELECT updated_at, expires_at FROM session').get(),
  ).not.toEqual(before);
  expect((await f.createTask(f.ownerCookie, 'Reopened')).status).toBe(200);
  ageSession(f, true);
  expect(
    await (
      await f.app.request('/api/auth/get-session', {
        headers: { cookie: f.ownerCookie },
      })
    ).json(),
  ).toBeNull();
  expect(f.db.sqlite.prepare('SELECT * FROM session').all()).toEqual([]);
  expect(
    (await f.app.request('/api/me', { headers: { cookie: f.ownerCookie } }))
      .status,
  ).toBe(401);
  expect((await f.signIn()).status).toBe(200);
});
