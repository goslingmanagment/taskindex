import {
  betterAuth,
  type BetterAuthOptions,
  type BetterAuthPlugin,
} from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { passkey } from '@better-auth/passkey';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from './schema.js';
import type { DatabaseHandle } from './db.js';
import type { Actor } from '../shared/model.js';
import { agentKeyIsActive, verifyAgentKey } from './agent-keys.js';
import type { AgentKeyCredential } from './agent-keys.js';
import type { HubSignin } from './hub-signin.js';
import { HUB_AGENT_KEY_PREFIX, type HubAgentKeys } from './hub-agent-keys.js';
import { fail } from '../shared/errors.js';
// «Войти через хаб»: the owner's session, opened by the server itself once the
// hub has said the person is the owner (src/server/hub-signin.ts). Not an
// HTTP route (SERVER_ONLY): only the callback calls it. The grant goes into
// the same INSERT as the session, so a hub session never exists without it;
// clients can neither set nor read it.
const hubSessions = () =>
  ({
    id: 'hub-signin',
    schema: {
      session: {
        fields: {
          hubGrant: {
            type: 'string',
            required: false,
            input: false,
            returned: false,
          },
        },
      },
    },
    endpoints: {
      openHubSession: createAuthEndpoint(
        '/hub/open-session',
        {
          method: 'POST',
          body: z.object({ grant: z.string().min(1).max(128) }),
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          const owner = await ctx.context.internalAdapter.findUserById('owner');
          if (!owner)
            throw new APIError('NOT_FOUND', {
              message: 'Владелец не создан.',
            });
          const session = await ctx.context.internalAdapter.createSession(
            owner.id,
            false,
            { hubGrant: ctx.body.grant },
          );
          await setSessionCookie(ctx, { session, user: owner });
          return ctx.json({ ok: true });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
export function createAuth(
  db: DatabaseHandle,
  options: {
    baseURL: string;
    secret: string;
    trustedOrigins?: string[];
    hub?: HubSignin;
    /** An agent's hub key (src/server/hub-agent-keys.ts); absent — such
     *  keys are unknown keys, as before. */
    hubAgentKeys?: HubAgentKeys;
  },
) {
  const config = {
    appName: 'TaskIndex',
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: options.trustedOrigins ?? [options.baseURL],
    database: drizzleAdapter(db.orm, { provider: 'sqlite', schema }),
    emailAndPassword: { enabled: true, disableSignUp: true },
    // Nginx overwrites this header with the peer address; the Node port stays private.
    advanced: { ipAddress: { ipAddressHeaders: ['x-real-ip'] } },
    rateLimit: { enabled: true },
    plugins: [
      passkey({
        rpID: new URL(options.baseURL).hostname,
        rpName: 'TaskIndex',
        origin: options.trustedOrigins ?? [options.baseURL],
      }),
      hubSessions(),
    ],
  } satisfies BetterAuthOptions;
  const auth = betterAuth(config);
  // disableRefresh alone still deletes expired sessions. Deferred GETs also
  // skip that cleanup, while Better Auth still checks the signed cookie and
  // current database row. Keep the ordinary auth instance's refresh behavior.
  const readOnly = betterAuth({
    ...config,
    session: { deferSessionRefresh: true, cookieCache: { enabled: false } },
  });
  return {
    ...auth,
    readSession: readOnly.api.getSession,
    hub: options.hub,
    hubAgentKeys: options.hubAgentKeys,
  };
}
export type Auth = ReturnType<typeof createAuth>;
// Private identity of a connection: never part of domain events or responses.
export type Credential =
  | AgentKeyCredential
  | { kind: 'hub-key'; hubAgent: string; agentId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'static' };
export type Authorized = {
  actor: Actor;
  credential: Credential;
  // Is this access still valid? Called before every SSE delivery and on each
  // heartbeat; must not write to the database.
  check: () => boolean | Promise<boolean>;
};
export const staticAuthorization = (actor: Actor): Authorized => ({
  actor,
  credential: { kind: 'static' },
  check: () => true,
});
// The hub's grant of a session opened by «Войти через хаб», or null for a
// password or passkey session.
const hubGrantOf = (db: DatabaseHandle, sessionId: string) =>
  db.orm
    .select({ grant: schema.session.hubGrant })
    .from(schema.session)
    .where(eq(schema.session.id, sessionId))
    .get()?.grant ?? null;
// Whether a session from the hub still holds there. One the hub calls over
// is removed (when writes are open); without the hub configured nothing can
// confirm it, the same. One the hub has not confirmed for longer than the
// grace is refused but kept: it holds again once the hub answers.
async function hubSessionHolds(
  db: DatabaseHandle,
  auth: Auth,
  session: { id: string; createdAt: Date },
  grant: string,
  readOnly: boolean,
) {
  const status = auth.hub
    ? await auth.hub.status(grant, session.createdAt.getTime())
    : 'ended';
  if (status === 'ended' && !readOnly)
    db.orm
      .delete(schema.session)
      .where(eq(schema.session.id, session.id))
      .run();
  return status === 'active';
}
// For `/api/auth/get-session`: true when the cookie's session came from the
// hub and does not hold there; the caller answers «no session».
export async function hubSessionRefused(
  db: DatabaseHandle,
  auth: Auth,
  headers: Headers,
  { readOnly }: { readOnly: boolean },
): Promise<boolean> {
  const s = await auth.readSession({
    headers,
    query: { disableRefresh: true },
  });
  if (!s) return false;
  const grant = hubGrantOf(db, s.session.id);
  return (
    grant !== null &&
    !(await hubSessionHolds(db, auth, s.session, grant, readOnly))
  );
}
/** What an agent's hub key did, for the request log: under the agent's code. */
export type HubKeyAudit = (fields: {
  hubAgent: string;
  outcome: 'ok' | 'not_linked' | 'agent_disabled';
  held: boolean;
  actor?: string;
}) => void;
const activeAgent = (db: DatabaseHandle, agentId: string) => {
  const row = db.orm
    .select({
      label: schema.agents.label,
      disabledAt: schema.agents.disabledAt,
    })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .get();
  return row && !row.disabledAt ? row : undefined;
};
// An agent's hub key: the hub says whose it is, `HUB_AGENTS` which TaskIndex
// agent it works as and with what scope. A code not in the table, or one
// whose agent is gone or disabled, gets nothing. Reads only, like a key.
async function authorizeHubKey(
  db: DatabaseHandle,
  keys: HubAgentKeys,
  token: string,
  audit: HubKeyAudit | undefined,
): Promise<Authorized> {
  const verdict = await keys.who(token);
  if (verdict.kind === 'unreachable')
    fail(
      'unavailable',
      'Ключ хаба не проверить: хаб не отвечает, а последнего ответа о ключе нет или ему больше часа.',
    );
  if (verdict.kind === 'refused')
    fail(
      'unavailable',
      'Ключ хаба не проверить: хаб отказал TaskIndex в ответе.',
    );
  if (verdict.kind === 'inactive')
    fail(
      'forbidden',
      'Ключ хаба не действует: отозван, истёк или не принадлежит агенту.',
    );
  const { code, held } = verdict;
  const link = Object.hasOwn(keys.agents, code) ? keys.agents[code] : undefined;
  if (!link) {
    audit?.({ hubAgent: code, outcome: 'not_linked', held });
    fail('forbidden', `Агенту хаба ${code} TaskIndex не открыт.`);
  }
  const agent = activeAgent(db, link.agentId);
  if (!agent) {
    audit?.({ hubAgent: code, outcome: 'agent_disabled', held });
    fail('forbidden', 'Агент отключён.');
  }
  const actor: Actor = {
    id: `agent:${link.agentId}`,
    agentId: link.agentId,
    label: agent.label,
    kind: 'agent',
    scope: link.scope,
  };
  audit?.({ hubAgent: code, outcome: 'ok', held, actor: actor.id });
  return {
    actor,
    credential: { kind: 'hub-key', hubAgent: code, agentId: link.agentId },
    check: async () => {
      const now = await keys.who(token).catch(() => null);
      return (
        now?.kind === 'active' &&
        now.code === code &&
        Boolean(activeAgent(db, link.agentId))
      );
    },
  };
}
export async function authorizeRequest(
  db: DatabaseHandle,
  auth: Auth,
  request: Request,
  { readOnly = false, audit }: { readOnly?: boolean; audit?: HubKeyAudit } = {},
): Promise<Authorized | null> {
  const bearer = request.headers.get('authorization');
  const token =
    bearer?.match(/^Bearer\s+(.+)$/i)?.[1] ?? request.headers.get('x-api-key');
  if (token) {
    if (auth.hubAgentKeys && token.startsWith(HUB_AGENT_KEY_PREFIX))
      return authorizeHubKey(db, auth.hubAgentKeys, token, audit);
    const { actor, credential } = verifyAgentKey(db, token);
    return {
      actor,
      credential,
      check: () => agentKeyIsActive(db, credential.keyId),
    };
  }
  const s = await (readOnly ? auth.readSession : auth.api.getSession)({
    headers: request.headers,
  });
  if (!s || s.user.id !== 'owner') return null;
  const grant = hubGrantOf(db, s.session.id);
  if (
    grant !== null &&
    !(await hubSessionHolds(db, auth, s.session, grant, readOnly))
  )
    return null;
  const headers = new Headers(request.headers);
  return {
    actor: { id: 'owner', label: s.user.name, kind: 'owner', scope: 'write' },
    credential: { kind: 'session', sessionId: s.session.id },
    check: async () => {
      const current = await auth.readSession({
        headers,
        query: { disableRefresh: true },
      });
      return Boolean(
        current &&
        current.user.id === 'owner' &&
        current.session.id === s.session.id &&
        (grant === null ||
          (await auth.hub?.status(grant, s.session.createdAt.getTime())) ===
            'active'),
      );
    },
  };
}
