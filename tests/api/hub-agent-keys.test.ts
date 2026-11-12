import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { openDatabase, migrate, generation } from '../../src/server/db.js';
import { createApp } from '../../src/server/app.js';
import { createAuth } from '../../src/server/auth.js';
import {
  createAgent,
  createAgentKey,
  createOwner,
  disableAgent,
} from '../../src/server/admin.js';
import {
  createHubAgentKeys,
  HUB_AGENT_KEY_PREFIX,
  HUB_KEY_FRESH_MS,
  parseHubAgents,
} from '../../src/server/hub-agent-keys.js';
import { ConfigError, loadServerConfig } from '../../src/server/config.js';
import type { LogFields, Logger } from '../../src/server/log.js';

// An agent's hub key (ecosystem M2): the hub is asked by the key's sha256
// only; the owner's table gives a hub agent's code an existing agent and its
// scope; a code not in the table, an inactive key or a disabled agent gets
// nothing; an answer holds a minute, an active one up to an hour while the
// hub is down, an inactive one never; every call is logged under the code.

const SERVICE_KEY = 'agency_hub_agent_service-key-of-taskindex';
const GENGAR = `${HUB_AGENT_KEY_PREFIX}gengar-key`;
const READER = `${HUB_AGENT_KEY_PREFIX}reader-key`;
const STRANGER = `${HUB_AGENT_KEY_PREFIX}stranger-key`;
const digest = (token: string) =>
  createHash('sha256').update(token).digest('hex');

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function fakeHub() {
  const hub = {
    active: new Map<string, string>([
      [digest(GENGAR), 'gengar'],
      [digest(READER), 'os-machine'],
      [digest(STRANGER), 'stranger'],
    ]),
    down: false,
    status: 200,
    expiresAt: '2027-11-01T00:00:00.000Z',
    bodies: new Array<string>(),
    fetch: (async (url: string, init: RequestInit & { body: string }) => {
      const { body } = init;
      hub.bodies.push(body);
      expect(url).toBe('https://hub.example.test/api/v1/agent/keys/introspect');
      expect((init.headers as Record<string, string>).authorization).toBe(
        `Bearer ${SERVICE_KEY}`,
      );
      if (hub.down) throw new TypeError('fetch failed');
      if (hub.status !== 200) return new Response('{}', { status: hub.status });
      const { keyDigest } = JSON.parse(body) as { keyDigest: string };
      const code = hub.active.get(keyDigest);
      return Response.json(
        code
          ? {
              active: true,
              agent: { code, displayName: code },
              expiresAt: hub.expiresAt,
              cacheSeconds: 60,
              staleSeconds: 3600,
            }
          : { active: false, cacheSeconds: 60, staleSeconds: 3600 },
      );
    }) as unknown as typeof fetch,
  };
  return hub;
}

async function setup(withHub = true) {
  const db = openDatabase(':memory:');
  migrate(db);
  await createOwner(db, {
    email: 'owner@example.test',
    password: 'a-test-password-with-entropy',
  });
  createAgent(db, { id: 'openclaw', label: 'OpenClaw' });
  createAgent(db, { id: 'renderer', label: 'Renderer' });
  const local = createAgentKey(db, { agentId: 'openclaw', scope: 'tasks' });
  const hub = fakeHub();
  let clock = Date.parse('2026-11-12T12:00:00.000Z');
  const lines: LogFields[] = [];
  const logger: Logger = {
    level: 'info',
    debug: () => {},
    info: (fields) => lines.push(fields),
    warn: () => {},
    error: () => {},
  };
  const auth = createAuth(db, {
    baseURL: 'http://localhost:3001',
    trustedOrigins: ['http://localhost:5173'],
    secret: 'test-only-32-character-secret-value-never-used-outside-tests',
    ...(withHub
      ? {
          hubAgentKeys: createHubAgentKeys({
            url: 'https://hub.example.test',
            key: SERVICE_KEY,
            agents: parseHubAgents(
              'gengar=openclaw:tasks,os-machine=renderer:read',
            ),
            fetch: hub.fetch,
            now: () => clock,
          }),
        }
      : {}),
  });
  const app = createApp({
    db,
    auth,
    baseURL: 'http://localhost:3001',
    trustedOrigins: ['http://localhost:5173'],
    writes: 'open',
    deploymentId: 'test-hub-keys',
    logger,
  });
  cleanup.push(() => {
    app.closeStreams();
    db.close();
  });
  const tasks = (token: string) =>
    app.request('/api/tasks', { headers: bearer(token) });
  let operations = 0;
  const createTask = (token: string) =>
    app.request('/api/commands', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        command: 'task.create',
        payload: { id: `t${++operations}`, area: 'agency', title: 'T' },
        operationId: `hub-create-${operations}`,
        generation: generation(db),
      }),
    });
  const calls = () => lines.filter((line) => line.event === 'hub_agent_call');
  return {
    db,
    app,
    hub,
    local: local.key,
    tasks,
    createTask,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

it('a hub key works as the linked agent with the scope of the table, and nothing more', async () => {
  const f = await setup();
  const read = await f.tasks(GENGAR);
  expect(read.status).toBe(200);
  const created = await f.createTask(GENGAR);
  expect(created.status).toBe(200);
  const me = await (
    await f.app.request('/api/me', {
      headers: { authorization: `Bearer ${GENGAR}` },
    })
  ).json();
  expect(me).toMatchObject({
    id: 'agent:openclaw',
    kind: 'agent',
    scope: 'tasks',
  });
  // The journal names the local agent, as for its own key.
  expect(
    f.db.sqlite
      .prepare("SELECT actor_id FROM operations WHERE id = 'hub-create-1'")
      .get(),
  ).toEqual({ actor_id: 'agent:openclaw' });
  // `read` in the table: reads, never writes.
  expect((await f.tasks(READER)).status).toBe(200);
  expect((await f.createTask(READER)).status).toBe(403);
  // A code the table does not hold, an inactive key: nothing.
  const stranger = await f.tasks(STRANGER);
  expect(stranger.status).toBe(403);
  expect((await stranger.json()).message).toContain('не открыт');
  const unknown = await f.tasks(`${HUB_AGENT_KEY_PREFIX}made-up`);
  expect(unknown.status).toBe(403);
  expect((await unknown.json()).message).toContain('не действует');
  // Local keys work as before.
  expect((await f.tasks(f.local)).status).toBe(200);
  expect((await f.createTask(f.local)).status).toBe(200);
  // Every call of a hub key is logged under its code; the key and its digest never.
  expect(f.calls().map((c) => [c.hubAgent, c.outcome, c.method])).toEqual([
    ['gengar', 'ok', 'GET'],
    ['gengar', 'ok', 'POST'],
    ['gengar', 'ok', 'GET'],
    ['os-machine', 'ok', 'GET'],
    ['os-machine', 'ok', 'POST'],
    ['stranger', 'not_linked', 'GET'],
  ]);
  const logged = JSON.stringify(f.calls());
  expect(logged).not.toContain(HUB_AGENT_KEY_PREFIX);
  expect(logged).not.toContain(digest(GENGAR));
  // The hub got only digests.
  for (const body of f.hub.bodies) {
    expect(Object.keys(JSON.parse(body))).toEqual(['keyDigest']);
    expect(body).not.toContain(HUB_AGENT_KEY_PREFIX);
  }
  // A disabled agent: its hub key stops at once.
  disableAgent(f.db, 'openclaw');
  expect((await f.tasks(GENGAR)).status).toBe(403);
  expect(f.calls().at(-1)).toMatchObject({ outcome: 'agent_disabled' });
});

it('a revoke at the hub is seen within the minute; a down hub holds an active answer up to an hour', async () => {
  const f = await setup();
  expect((await f.tasks(GENGAR)).status).toBe(200);
  f.hub.active.delete(digest(GENGAR));
  f.advance(HUB_KEY_FRESH_MS - 1_000);
  expect((await f.tasks(GENGAR)).status).toBe(200);
  f.advance(2_000);
  expect((await f.tasks(GENGAR)).status).toBe(403);
  // An inactive answer is never extended.
  f.hub.down = true;
  f.advance(HUB_KEY_FRESH_MS + 1_000);
  const down = await f.tasks(GENGAR);
  expect(down.status).toBe(503);
  expect((await down.json()).message).toContain('хаб не отвечает');

  f.hub.down = false;
  f.hub.active.set(digest(GENGAR), 'gengar');
  f.advance(HUB_KEY_FRESH_MS + 1_000);
  expect((await f.tasks(GENGAR)).status).toBe(200);
  f.hub.down = true;
  f.advance(10 * 60_000);
  expect((await f.tasks(GENGAR)).status).toBe(200);
  expect(f.calls().at(-1)).toMatchObject({ hubAgent: 'gengar', held: true });
  const asked = f.hub.bodies.length;
  f.advance(5_000);
  expect((await f.tasks(GENGAR)).status).toBe(200);
  expect(f.hub.bodies.length).toBe(asked);
  f.advance(49 * 60_000 + 50_000);
  expect((await f.tasks(GENGAR)).status).toBe(200);
  f.advance(10_000);
  expect((await f.tasks(GENGAR)).status).toBe(503);
});

it('a 4xx of the hub is an answer: refused, nothing held after it', async () => {
  const f = await setup();
  expect((await f.tasks(GENGAR)).status).toBe(200);
  f.hub.status = 403;
  f.advance(HUB_KEY_FRESH_MS + 1_000);
  const refused = await f.tasks(GENGAR);
  expect(refused.status).toBe(503);
  expect((await refused.json()).message).toContain('хаб отказал');
  f.hub.status = 200;
  f.hub.down = true;
  expect((await f.tasks(GENGAR)).status).toBe(503);
});

it('an answer never outlives the key', async () => {
  const f = await setup();
  f.hub.expiresAt = '2026-11-12T12:00:30.000Z';
  expect((await f.tasks(GENGAR)).status).toBe(200);
  f.advance(31_000);
  expect((await f.tasks(GENGAR)).status).toBe(403);
});

it('without its own hub key TaskIndex takes a hub key for an unknown key', async () => {
  const f = await setup(false);
  expect((await f.tasks(GENGAR)).status).toBe(403);
  expect(f.hub.bodies).toEqual([]);
  expect((await f.tasks(f.local)).status).toBe(200);
});

it('the table and the key are configured strictly', () => {
  expect(
    parseHubAgents('gengar=openclaw:tasks, os-machine=renderer:read'),
  ).toEqual({
    gengar: { agentId: 'openclaw', scope: 'tasks' },
    'os-machine': { agentId: 'renderer', scope: 'read' },
  });
  for (const bad of [
    'gengar=openclaw',
    'gengar=openclaw:admin',
    'Gengar=openclaw:read',
    'gengar=open claw:read',
    'gengar=a:read,gengar=b:read',
  ])
    expect(() => parseHubAgents(bad)).toThrow();
  const base = { BETTER_AUTH_SECRET: 'x'.repeat(32) };
  expect(loadServerConfig(base).hubAgentKeys).toBeUndefined();
  expect(() =>
    loadServerConfig({ ...base, HUB_INTROSPECT_KEY: 'k'.repeat(20) }),
  ).toThrow(ConfigError);
  expect(() =>
    loadServerConfig({ ...base, HUB_AGENTS: 'gengar=openclaw:root' }),
  ).toThrow(ConfigError);
  expect(
    loadServerConfig({
      ...base,
      HUB_INTROSPECT_KEY: 'k'.repeat(20),
      HUB_SIGNIN_URL: 'https://hub.example.test',
      HUB_SIGNIN_KEY: 's'.repeat(20),
      HUB_AGENTS: 'gengar=openclaw:tasks',
    }).hubAgentKeys,
  ).toEqual({
    url: 'https://hub.example.test',
    key: 'k'.repeat(20),
    agents: { gengar: { agentId: 'openclaw', scope: 'tasks' } },
  });
});
