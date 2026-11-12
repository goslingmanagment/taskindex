import { afterEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import { generation, migrate, openDatabase } from '../../src/server/db.js';
import { createApp } from '../../src/server/app.js';
import { createAuth } from '../../src/server/auth.js';
import {
  createAgent,
  createAgentKey,
  createOwner,
} from '../../src/server/admin.js';
import {
  HUB_CHECK_CACHE_MS,
  HUB_UNREACHABLE_GRACE_MS,
  createHubSignin,
  safeNext,
} from '../../src/server/hub-signin.js';

// «Войти через хаб»: the hub is a real Hono app speaking the contract of
// hub PR #1213 (sso/redeem, sso/check), reached through an injected fetch.
const HUB = 'http://hub.test';
const HUB_KEY = 'taskindex-hub-key-for-tests-only';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function fakeHub() {
  const codes = new Map<string, { owner: boolean; grant: string }>();
  const grants = new Map<string, boolean>();
  const calls: string[] = [];
  let down = false;
  let serial = 0;
  const hub = new Hono();
  const keyed = (header: string | undefined) => header === `Bearer ${HUB_KEY}`;
  hub.post('/api/v1/auth/sso/redeem', async (c) => {
    if (!keyed(c.req.header('authorization')))
      return c.json({ error: 'unauthorized' }, 401);
    const { client, code } = await c.req.json<{
      client: string;
      code: string;
    }>();
    const minted = codes.get(code);
    // The first presentation spends the code, whatever the outcome.
    codes.delete(code);
    if (!minted || client !== 'taskindex')
      return c.json({ error: 'conflict' }, 409);
    grants.set(minted.grant, true);
    return c.json({
      user: {
        id: minted.owner ? 1 : 2,
        username: minted.owner ? 'dev-owner' : 'dev-chatter',
        role: minted.owner ? 'owner' : 'chatter',
      },
      owner: minted.owner,
      grant: minted.grant,
      expiresAt: '2026-12-31T00:00:00.000Z',
    });
  });
  hub.post('/api/v1/auth/sso/check', async (c) => {
    if (!keyed(c.req.header('authorization')))
      return c.json({ error: 'unauthorized' }, 401);
    const { grant } = await c.req.json<{ grant: string }>();
    return grants.get(grant)
      ? c.json({
          active: true,
          user: { id: 1, username: 'dev-owner', role: 'owner' },
          owner: true,
          expiresAt: '2026-12-31T00:00:00.000Z',
        })
      : c.json({ active: false });
  });
  return {
    calls,
    mint(owner: boolean) {
      const code = `code-${++serial}-${'x'.repeat(30)}`;
      codes.set(code, { owner, grant: `grant-${serial}` });
      return code;
    },
    revoke: (grant: string) => grants.set(grant, false),
    setDown: (value: boolean) => {
      down = value;
    },
    fetch: (async (input: string, init?: RequestInit) => {
      calls.push(new URL(input).pathname);
      if (down) throw new TypeError('fetch failed');
      return hub.request(input, init);
    }) as typeof fetch,
  };
}

let fixtures = 0;
async function setup(writes: 'open' | 'held' = 'open') {
  const ip = `198.51.100.${++fixtures}`;
  let now = Date.now();
  const hub = fakeHub();
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
    hub: createHubSignin({
      url: HUB,
      client: 'taskindex',
      key: HUB_KEY,
      fetch: hub.fetch,
      now: () => now,
    }),
  });
  const app = createApp({
    db,
    auth,
    baseURL: 'http://localhost:3001',
    trustedOrigins: ['http://localhost:5173'],
    writes,
    deploymentId: 'test-hub-signin',
  });
  cleanup.push(() => {
    app.closeStreams();
    db.close();
  });
  const sessions = () =>
    db.sqlite
      .prepare('SELECT hub_grant AS grant FROM session ORDER BY created_at')
      .all() as { grant: string | null }[];
  // The browser's first step: TaskIndex's own state cookie and the hub's address.
  const start = async (next = '/') => {
    const response = await app.request(
      `/auth/hub?next=${encodeURIComponent(next)}`,
    );
    const location = new URL(response.headers.get('location')!);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return { response, location, cookie };
  };
  const callback = async (query: Record<string, string>, cookie?: string) =>
    app.request(`/auth/hub/callback?${new URLSearchParams(query)}`, {
      headers: { 'x-real-ip': ip, ...(cookie ? { cookie } : {}) },
    });
  // The whole hand-off; returns the session cookie it set, if any.
  const signInThroughHub = async (owner = true) => {
    const { location, cookie } = await start('/area/dev');
    const code = hub.mint(owner);
    const response = await callback(
      {
        code,
        state: location.searchParams.get('state')!,
        next: location.searchParams.get('next')!,
      },
      cookie,
    );
    const session = response.headers
      .getSetCookie()
      .find((c) => c.startsWith('better-auth.session_token='));
    return {
      response,
      code,
      cookie,
      state: location.searchParams.get('state')!,
      session: session?.split(';')[0],
    };
  };
  const me = (cookie: string) =>
    app.request('/api/me', { headers: { cookie } });
  return {
    db,
    app,
    hub,
    sessions,
    start,
    callback,
    signInThroughHub,
    me,
    advance: (ms: number) => {
      now += ms;
    },
    signInWithPassword: () =>
      app.request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:5173',
          'x-real-ip': ip,
        },
        body: JSON.stringify({
          email: 'owner@example.test',
          password: 'a-test-password-with-entropy',
        }),
      }),
  };
}

it("sends the browser to the hub with this browser's own state", async () => {
  const f = await setup();
  expect(await (await f.app.request('/auth/hub/available')).json()).toEqual({
    available: true,
  });
  const { response, location, cookie } = await f.start('/area/dev?q=1');
  expect(response.status).toBe(302);
  expect(location.origin + location.pathname).toBe(`${HUB}/api/v1/auth/sso`);
  expect(location.searchParams.get('to')).toBe('taskindex');
  expect(location.searchParams.get('next')).toBe('/area/dev?q=1');
  const state = location.searchParams.get('state')!;
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(cookie).toBe(`ti_hub_state=${state}`);
  expect(response.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax/);
  expect(f.hub.calls).toEqual([]);
});

it("opens TaskIndex's own owner session for the hub's owner, with the grant", async () => {
  const f = await setup();
  const { response, session } = await f.signInThroughHub();
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('/area/dev');
  // The state is spent with the return.
  expect(
    response.headers
      .getSetCookie()
      .some((c) => /^ti_hub_state=;.*Max-Age=0/.test(c)),
  ).toBe(true);
  expect(session).toBeDefined();
  expect(f.sessions()).toEqual([{ grant: 'grant-1' }]);
  const answer = await f.me(session!);
  expect(answer.status).toBe(200);
  expect(await answer.json()).toMatchObject({ id: 'owner', kind: 'owner' });
  // The grant is never shown to the browser.
  const own = await f.app.request('/api/auth/get-session', {
    headers: { cookie: session! },
  });
  expect(JSON.stringify(await own.json())).not.toContain('grant-1');
});

it("refuses a callback whose state is not this browser's, without redeeming", async () => {
  const f = await setup();
  const { location, cookie } = await f.start();
  const code = f.hub.mint(true);
  const state = location.searchParams.get('state')!;
  const tries = [
    f.callback({ code, state }),
    f.callback({ code, state: `${state.slice(0, -1)}A` }, cookie),
    f.callback({ code }, cookie),
    f.callback(
      { code, state: 'a'.repeat(43) },
      `ti_hub_state=${'a'.repeat(43)}x`,
    ),
  ];
  for (const response of await Promise.all(tries)) {
    expect(response.headers.get('location')).toBe('/?hub_signin=state');
    expect(
      response.headers
        .getSetCookie()
        .some((c) => c.startsWith('better-auth.session_token=')),
    ).toBe(false);
  }
  expect(f.hub.calls).toEqual([]);
  expect(f.sessions()).toEqual([]);
});

it('opens nothing for a replayed code', async () => {
  const f = await setup();
  const first = await f.signInThroughHub();
  expect(first.session).toBeDefined();
  const again = await f.start();
  const replay = await f.callback(
    { code: first.code, state: again.location.searchParams.get('state')! },
    again.cookie,
  );
  expect(replay.headers.get('location')).toBe('/?hub_signin=expired');
  expect(
    replay.headers
      .getSetCookie()
      .some((c) => c.startsWith('better-auth.session_token=')),
  ).toBe(false);
  expect(f.sessions()).toHaveLength(1);
});

it('gives no session to a person who is not the owner', async () => {
  const f = await setup();
  const { response, session } = await f.signInThroughHub(false);
  expect(response.headers.get('location')).toBe('/?hub_signin=not_owner');
  expect(session).toBeUndefined();
  expect(f.sessions()).toEqual([]);
});

it('ends the session here once the grant is revoked at the hub', async () => {
  const f = await setup();
  const { session } = await f.signInThroughHub();
  f.hub.revoke('grant-1');
  // An answer is used for up to a minute…
  expect((await f.me(session!)).status).toBe(200);
  f.advance(HUB_CHECK_CACHE_MS);
  // …then asked again: over at the hub, over here.
  expect((await f.me(session!)).status).toBe(401);
  expect(f.sessions()).toEqual([]);
  const own = await f.app.request('/api/auth/get-session', {
    headers: { cookie: session! },
  });
  expect(await own.json()).toBeNull();
});

it('signs out on get-session too, so the page shows the sign-in screen', async () => {
  const f = await setup();
  const { session } = await f.signInThroughHub();
  f.hub.revoke('grant-1');
  f.advance(HUB_CHECK_CACHE_MS);
  const own = await f.app.request('/api/auth/get-session', {
    headers: { cookie: session! },
  });
  expect(await own.json()).toBeNull();
  expect(f.sessions()).toEqual([]);
});

it('holds the last yes while the hub does not answer, for a bounded time', async () => {
  const f = await setup();
  const { session } = await f.signInThroughHub();
  f.hub.setDown(true);
  f.advance(HUB_CHECK_CACHE_MS);
  expect((await f.me(session!)).status).toBe(200);
  f.advance(HUB_UNREACHABLE_GRACE_MS);
  expect((await f.me(session!)).status).toBe(401);
  const own = await f.app.request('/api/auth/get-session', {
    headers: { cookie: session! },
  });
  expect(await own.json()).toBeNull();
  // Refused, not ended: back up and still signed in there, it holds again.
  expect(f.sessions()).toEqual([{ grant: 'grant-1' }]);
  f.hub.setDown(false);
  f.advance(HUB_CHECK_CACHE_MS);
  expect((await f.me(session!)).status).toBe(200);
});

it('opens nothing while writes are held', async () => {
  const f = await setup('held');
  expect((await f.app.request('/auth/hub')).headers.get('location')).toBe(
    '/?hub_signin=held',
  );
  expect(f.hub.calls).toEqual([]);
});

it('keeps the password sign-in as it was, and it never asks the hub', async () => {
  const f = await setup();
  const login = await f.signInWithPassword();
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  f.advance(HUB_CHECK_CACHE_MS * 5);
  f.hub.setDown(true);
  expect((await f.me(cookie)).status).toBe(200);
  expect(f.sessions()).toEqual([{ grant: null }]);
  expect(f.hub.calls).toEqual([]);
});

it('never asks the hub for an agent key, a stream, health or the page', async () => {
  const f = await setup();
  await f.signInThroughHub();
  const before = f.hub.calls.length;
  f.advance(HUB_CHECK_CACHE_MS * 2);
  f.hub.setDown(true);
  createAgent(f.db, { id: 'worker', label: 'Worker' });
  const key = createAgentKey(f.db, { agentId: 'worker', scope: 'write' });
  const headers = { authorization: `Bearer ${key.key}` };
  expect((await f.app.request('/api/me', { headers })).status).toBe(200);
  expect((await f.app.request('/api/snapshot', { headers })).status).toBe(200);
  const write = await f.app.request('/api/commands', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      command: 'task.create',
      payload: { id: 'k', area: 'agency', title: 'K' },
      operationId: 'keyed-write',
      generation: generation(f.db),
    }),
  });
  expect(write.status).toBe(200);
  const stream = await f.app.request(
    `/api/events/stream?generation=${generation(f.db)}`,
    { headers },
  );
  expect(stream.status).toBe(200);
  await stream.body?.cancel();
  expect((await f.app.request('/health')).status).toBe(200);
  expect(f.hub.calls).toHaveLength(before);
});

it('lands only on a path of TaskIndex', () => {
  for (const raw of [
    undefined,
    '',
    'https://evil.example/',
    '//evil.example/',
    '/\\evil.example',
    '/\tx',
    '/api/me',
    '/auth/hub',
    'javascript:alert(1)',
  ])
    expect(safeNext(raw)).toBe('/');
  expect(safeNext('/area/dev?q=1')).toBe('/area/dev?q=1');
});
