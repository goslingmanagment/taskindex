import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Deps, Env } from './http/deps.js';

// «Войти через хаб» (ecosystem plan §3.2, package B2): the owner signed in
// to the agency hub opens TaskIndex without a second sign-in.
//
// 1. `GET /auth/hub` sets this browser's state cookie and sends it to the
//    hub's `/api/v1/auth/sso?to=taskindex&state=…&next=…`.
// 2. The hub sends it back to `GET /auth/hub/callback?code=…&state=…&next=…`
//    (outside /api/, the address registered at the hub). The state must be
//    this browser's own; the code is redeemed server to server with
//    TaskIndex's own hub key (`signin:taskindex`), once, within 60 s.
// 3. Only `owner: true` opens TaskIndex's OWN owner session (Better Auth,
//    the same as a password sign-in), which remembers the hub's grant.
// 4. Every request of that session is re-checked at the hub (`sso/check`,
//    an answer is used for 60 s). Signed out or revoked at the hub — the
//    session ends here. While the hub does not answer (its deploy), the last
//    «yes» holds for 30 minutes; past that the session is refused (not
//    ended) until the hub answers again.
//
// Agent keys never reach this module: `authorizeRequest` answers a key
// before it looks at any session.

export type HubSigninConfig = {
  /** The hub's name the browser is sent to (`https://hub.gosling-agency.ru`). */
  url: string;
  /** Where this server redeems and re-checks (any hub name); `url` by default. */
  apiUrl?: string;
  /** This service's client name at the hub. */
  client: string;
  /** TaskIndex's own hub agent key, holding `signin:<client>`. */
  key: string;
};

/** How long a hub answer about a grant is used before it is asked again. */
export const HUB_CHECK_CACHE_MS = 60_000;
/** How long the last «yes» holds while the hub does not answer at all. */
export const HUB_UNREACHABLE_GRACE_MS = 30 * 60_000;
const HUB_TIMEOUT_MS = 5_000;
/** Redeems this server sends per minute, whoever asks: a flood of made-up
 *  codes must not spend the key's allowance at the hub. */
const REDEEMS_PER_MINUTE = 10;

type HubPerson = { id: number; username: string; role: string };
export type RedeemOutcome =
  | { kind: 'owner'; grant: string; user: HubPerson }
  | { kind: 'not_owner'; user: HubPerson }
  | { kind: 'refused' }
  | { kind: 'unreachable' };

export type HubSignin = {
  readonly client: string;
  startUrl(state: string, next: string): string;
  redeem(code: string): Promise<RedeemOutcome>;
  /** Whether a session opened from the hub still holds: `active`; `ended` —
   *  over at the hub, for good; `unconfirmed` — the hub has not answered for
   *  longer than the grace. `since`: when the hub last said yes as far as
   *  this server knows (the session's creation). */
  status(grant: string, since: number): Promise<HubSessionStatus>;
};
export type HubSessionStatus = 'active' | 'ended' | 'unconfirmed';

const personSchema = z.object({
  id: z.number(),
  username: z.string(),
  role: z.string(),
});
const redeemSchema = z.object({
  user: personSchema,
  owner: z.boolean(),
  grant: z.string().min(1).max(128),
});
const checkSchema = z.object({
  active: z.boolean(),
  owner: z.boolean().optional(),
});

type Entry = {
  /** The hub said this sign-in is over: final. */
  ended: boolean;
  /** When the hub last said it is alive. */
  confirmedAt: number;
  /** When the hub was last asked, answered or not. */
  askedAt: number;
};

export function createHubSignin(
  config: HubSigninConfig & {
    fetch?: typeof fetch;
    now?: () => number;
  },
): HubSignin {
  const send = config.fetch ?? fetch;
  const clock = config.now ?? Date.now;
  const api = (config.apiUrl ?? config.url).replace(/\/+$/, '');
  const entries = new Map<string, Entry>();
  const asking = new Map<string, Promise<void>>();
  const post = async (path: string, body: unknown) => {
    try {
      const response = await send(`${api}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.key}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
      });
      // A redirect, a limit or the hub's own failure: no answer about the person.
      if (
        response.status === 429 ||
        response.status >= 500 ||
        (response.status >= 300 && response.status < 400)
      )
        return null;
      return {
        status: response.status,
        body: (await response.json().catch(() => null)) as unknown,
      };
    } catch {
      return null;
    }
  };
  const ask = async (grant: string, entry: Entry) => {
    const answer = await post('/api/v1/auth/sso/check', {
      client: config.client,
      grant,
    });
    const at = clock();
    entry.askedAt = at;
    if (answer === null) return;
    const parsed = checkSchema.safeParse(answer.body);
    // Any other definite answer (the key refused, the grant malformed)
    // cannot confirm the sign-in: it ends, as when the hub says so.
    if (
      answer.status === 200 &&
      parsed.success &&
      parsed.data.active &&
      parsed.data.owner === true
    )
      entry.confirmedAt = at;
    else entry.ended = true;
  };
  const verdict = (entry: Entry, now: number): HubSessionStatus => {
    if (entry.ended) return 'ended';
    return now - entry.confirmedAt < HUB_UNREACHABLE_GRACE_MS
      ? 'active'
      : 'unconfirmed';
  };
  let redeems: number[] = [];
  return {
    client: config.client,
    startUrl(state, next) {
      const url = new URL('/api/v1/auth/sso', `${config.url}/`);
      url.search = new URLSearchParams({
        to: config.client,
        state,
        next,
      }).toString();
      return url.href;
    },
    async redeem(code) {
      const now = clock();
      redeems = redeems.filter((at) => now - at < 60_000);
      if (redeems.length >= REDEEMS_PER_MINUTE) return { kind: 'unreachable' };
      redeems.push(now);
      const answer = await post('/api/v1/auth/sso/redeem', {
        client: config.client,
        code,
      });
      if (answer === null) return { kind: 'unreachable' };
      if (answer.status !== 200) return { kind: 'refused' };
      const parsed = redeemSchema.safeParse(answer.body);
      if (!parsed.success) return { kind: 'unreachable' };
      const { user, owner, grant } = parsed.data;
      if (!owner) return { kind: 'not_owner', user };
      entries.set(grant, { ended: false, confirmedAt: now, askedAt: now });
      return { kind: 'owner', grant, user };
    },
    async status(grant, since) {
      let entry = entries.get(grant);
      if (!entry) {
        if (entries.size >= 256)
          for (const [key, value] of entries)
            if (verdict(value, clock()) !== 'active') entries.delete(key);
        // After a restart: the redeem at the session's creation was a «yes».
        entry = { ended: false, confirmedAt: since, askedAt: since };
        entries.set(grant, entry);
      }
      if (entry.ended) return 'ended';
      if (clock() - entry.askedAt >= HUB_CHECK_CACHE_MS) {
        let pending = asking.get(grant);
        if (!pending) {
          pending = ask(grant, entry).finally(() => asking.delete(grant));
          asking.set(grant, pending);
        }
        await pending;
      }
      return verdict(entry, clock());
    },
  };
}

/** A path of TaskIndex to land on after the sign-in; anything else is `/`. */
export function safeNext(raw: string | undefined): string {
  if (
    !raw ||
    raw.length > 2048 ||
    !raw.startsWith('/') ||
    raw.startsWith('//') ||
    // Backslashes, control characters and whitespace: browsers read some of
    // them as another host.
    /[\\\s\p{Cc}]/u.test(raw) ||
    /^\/(api|auth)(\/|\?|#|$)/i.test(raw)
  )
    return '/';
  return raw;
}

// What the sign-in screen says after a failed attempt (src/web/app/auth.tsx).
export type HubNotice =
  | 'not_owner'
  | 'expired'
  | 'state'
  | 'unavailable'
  | 'held'
  | 'error';

const STATE_COOKIE = 'ti_hub_state';
const STATE_MAX_AGE_SECONDS = 600;
const STATE_VALUE = /^[A-Za-z0-9_-]{43}$/;

const sameValue = (given: string, expected: string) =>
  timingSafeEqual(
    createHash('sha256').update(given).digest(),
    createHash('sha256').update(expected).digest(),
  );

// Every browser step answers with a redirect that is never stored and sends
// no Referer on (the hub's code is in the address).
const leave = (c: Context<Env>, location: string) => {
  c.header('cache-control', 'no-store');
  c.header('referrer-policy', 'no-referrer');
  return c.redirect(location, 302);
};
const notice = (c: Context<Env>, reason: HubNotice) =>
  leave(c, `/?hub_signin=${reason}`);

export function registerHubSigninRoutes(
  app: OpenAPIHono<Env>,
  deps: Deps,
  baseURL: string,
) {
  const { options, opened, logger } = deps;
  const hub = options.auth?.hub;
  const secure = baseURL.startsWith('https:');
  // `__Host-` in production: Secure, Path=/, no Domain, so no sibling name
  // can set it for this one.
  const prefix = secure ? ('host' as const) : undefined;
  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite: 'Lax' as const,
    path: '/',
    prefix,
  };
  // Whether the sign-in screen offers «Войти через хаб».
  app.get('/auth/hub/available', (c) => {
    c.header('cache-control', 'no-store');
    return c.json({ available: Boolean(hub) });
  });

  app.get('/auth/hub', (c) => {
    if (!hub) return leave(c, '/');
    // Opening a session is a write: not while writes are held.
    if (!opened()) return notice(c, 'held');
    const state = randomBytes(32).toString('base64url');
    setCookie(c, STATE_COOKIE, state, {
      ...cookieOptions,
      maxAge: STATE_MAX_AGE_SECONDS,
    });
    return leave(c, hub.startUrl(state, safeNext(c.req.query('next'))));
  });

  app.get('/auth/hub/callback', async (c) => {
    if (!hub || !options.auth) return leave(c, '/');
    const expected = getCookie(c, STATE_COOKIE, prefix);
    // The state is good for one return only.
    if (expected !== undefined) deleteCookie(c, STATE_COOKIE, cookieOptions);
    const state = c.req.query('state');
    if (
      expected === undefined ||
      !STATE_VALUE.test(expected) ||
      state === undefined ||
      !sameValue(state, expected)
    )
      return notice(c, 'state');
    const code = c.req.query('code');
    if (!code || code.length > 128) return notice(c, 'expired');
    if (!opened()) return notice(c, 'held');
    const outcome = await hub.redeem(code);
    if (outcome.kind === 'unreachable') return notice(c, 'unavailable');
    if (outcome.kind === 'refused') return notice(c, 'expired');
    if (outcome.kind === 'not_owner') {
      logger.warn({ event: 'hub_signin_not_owner', hubUser: outcome.user.id });
      return notice(c, 'not_owner');
    }
    try {
      const session = await options.auth.api.openHubSession({
        body: { grant: outcome.grant },
        headers: c.req.raw.headers,
        asResponse: true,
      });
      if (!session.ok) return notice(c, 'error');
      for (const cookie of session.headers.getSetCookie())
        c.header('set-cookie', cookie, { append: true });
    } catch {
      return notice(c, 'error');
    }
    logger.info({ event: 'hub_signin', hubUser: outcome.user.id });
    return leave(c, safeNext(c.req.query('next')));
  });
}
