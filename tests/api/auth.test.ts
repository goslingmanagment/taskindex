import { afterEach, it, expect } from 'vitest';
import {
  openDatabase,
  migrate,
  generation,
  readState,
} from '../../src/server/db.js';
import { createApp } from '../../src/server/app.js';
import { createAuth } from '../../src/server/auth.js';
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
async function setup(writes: 'open' | 'held' = 'open') {
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
        'x-real-ip': '203.0.113.10',
        'x-forwarded-for': '198.51.100.20, 203.0.113.10',
      },
      body: JSON.stringify({ email: 'owner@example.test', password }),
    });
  return { db, auth, app, signIn };
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
    ip_address: '203.0.113.10',
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
  const first = await createAgentKey(f.db, f.auth, {
    agentId: 'worker',
    scope: 'tasks',
  });
  const second = await createAgentKey(f.db, f.auth, {
    agentId: 'worker',
    scope: 'tasks',
  });
  const read = await createAgentKey(f.db, f.auth, {
    agentId: 'worker',
    scope: 'read',
  });
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
    f.db.sqlite.prepare('SELECT key FROM apikey WHERE id=?').get(first.id),
  ).not.toEqual({ key: first.key });
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
