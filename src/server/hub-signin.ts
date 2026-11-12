import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { authorizeRequest } from './auth.js';
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
// 5. Silent sign-in (package B5): a top-level page navigation without a
//    session gets ONE try before the sign-in screen — the same hand-off with
//    `silent=1`. The hub answers with a code (signed in there: in here at
//    once, on the page asked) or with `error=none` (nobody there: the page
//    shows the sign-in screen). The try is marked BEFORE the browser leaves
//    (`ti_hub_try`, 10 minutes), so a hub that does not answer costs at most
//    one failed navigation; the hub is asked first whether it answers at all,
//    so mostly not even that. «Выйти» here leaves `ti_hub_out` until the
//    browser session ends or «Войти через хаб» is pressed: a sign-out is
//    never undone by the next page load.
//
// Agent keys never reach this module: `authorizeRequest` answers a key
// before it looks at any session; the silent try takes only a page
// navigation without a key (`isPageNavigation`).

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
/** How long the silent try waits to learn whether the hub answers at all. */
const HUB_PROBE_TIMEOUT_MS = 2_000;
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
  /** `silent`: the hub never shows its sign-in page, nobody there comes
   *  back as `error=none`. */
  startUrl(state: string, next: string, silent?: boolean): string;
  /** Whether the hub answers at all (its health), before a silent try. */
  answers(): Promise<boolean>;
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

/** Whether the hub at `api` answers at all: its health, within 2 s. */
async function hubAnswers(send: typeof fetch, api: string): Promise<boolean> {
  try {
    const response = await send(`${api}/api/v1/health`, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(HUB_PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

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
    startUrl(state, next, silent = false) {
      const url = new URL('/api/v1/auth/sso', `${config.url}/`);
      url.search = new URLSearchParams({
        to: config.client,
        state,
        next,
        ...(silent ? { silent: '1' } : {}),
      }).toString();
      return url.href;
    },
    answers: () => hubAnswers(send, api),
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

// What the sign-in screen says after a failed attempt (src/web/app/auth.tsx);
// `none` (a silent try found nobody at the hub) says nothing.
export type HubNotice =
  | 'none'
  | 'not_owner'
  | 'expired'
  | 'state'
  | 'unavailable'
  | 'held'
  | 'error';

const STATE_COOKIE = 'ti_hub_state';
const STATE_MAX_AGE_SECONDS = 600;
/** A silent try was made: no other for this long. */
const TRY_COOKIE = 'ti_hub_try';
const TRY_MAX_AGE_SECONDS = 600;
/** «Выйти» was pressed here: no silent try until the browser session ends. */
const OUT_COOKIE = 'ti_hub_out';
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
/** `path` (already `safeNext`) with the notice: the page asked, not `/`. */
const withNotice = (path: string, reason: HubNotice) => {
  const url = new URL(path, 'http://taskindex.invalid');
  url.searchParams.set('hub_signin', reason);
  return `${url.pathname}${url.search}${url.hash}`;
};

/** A top-level page load of a browser: never an API call, a key, a file or
 *  a health check. */
function isPageNavigation(c: Context<Env>): boolean {
  if (c.req.method !== 'GET') return false;
  const path = c.req.path;
  if (/^\/(api|auth|assets|health)(\/|$)/i.test(path)) return false;
  // A file of the build (`/favicon.svg`), not a page of the app.
  if (/\.[A-Za-z0-9]+$/.test(path)) return false;
  if (c.req.header('authorization') || c.req.header('x-api-key')) return false;
  const dest = c.req.header('sec-fetch-dest');
  if (dest !== undefined) return dest === 'document';
  return (c.req.header('accept') ?? '').includes('text/html');
}

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
  const tryOnce = (c: Context<Env>) =>
    setCookie(c, TRY_COOKIE, '1', {
      ...cookieOptions,
      maxAge: TRY_MAX_AGE_SECONDS,
    });

  // The silent try (5. above): before the page is served.
  app.use('*', async (c, next) => {
    if (
      !hub ||
      !options.auth ||
      !isPageNavigation(c) ||
      // Back from a try (also a loop guard where cookies are refused).
      c.req.query('hub_signin') !== undefined ||
      getCookie(c, TRY_COOKIE, prefix) !== undefined ||
      getCookie(c, OUT_COOKIE, prefix) !== undefined ||
      !opened()
    )
      return next();
    const signedIn = await authorizeRequest(deps.db, options.auth, c.req.raw, {
      readOnly: true,
    });
    if (signedIn) return next();
    if (!(await hub.answers())) {
      logger.warn({ event: 'hub_signin_silent_skipped' });
      await next();
      tryOnce(c);
      return;
    }
    const state = randomBytes(32).toString('base64url');
    setCookie(c, STATE_COOKIE, state, {
      ...cookieOptions,
      maxAge: STATE_MAX_AGE_SECONDS,
    });
    tryOnce(c);
    const url = new URL(c.req.url);
    return leave(
      c,
      hub.startUrl(state, safeNext(`${url.pathname}${url.search}`), true),
    );
  });

  // «Выйти» (Better Auth's sign-out): marked so the next page load does not
  // sign the person back in through the hub.
  app.use('/api/auth/sign-out', async (c, next) => {
    await next();
    if (hub && c.req.method === 'POST' && c.res.ok)
      setCookie(c, OUT_COOKIE, '1', cookieOptions);
  });

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
    // Pressed by the person: the «signed out here» mark is over, and a
    // failure here is not followed by a silent try.
    if (getCookie(c, OUT_COOKIE, prefix) !== undefined)
      deleteCookie(c, OUT_COOKIE, cookieOptions);
    tryOnce(c);
    return leave(c, hub.startUrl(state, safeNext(c.req.query('next'))));
  });

  app.get('/auth/hub/callback', async (c) => {
    if (!hub || !options.auth) return leave(c, '/');
    const expected = getCookie(c, STATE_COOKIE, prefix);
    // The state is good for one return only.
    if (expected !== undefined) deleteCookie(c, STATE_COOKIE, cookieOptions);
    // A silent try found nobody at the hub: the page asked, which shows the
    // sign-in screen. Nothing is redeemed; `next` is a path of ours only.
    if (c.req.query('error') !== undefined) {
      tryOnce(c);
      return leave(c, withNotice(safeNext(c.req.query('next')), 'none'));
    }
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
