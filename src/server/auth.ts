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
  return { ...auth, readSession: readOnly.api.getSession, hub: options.hub };
}
export type Auth = ReturnType<typeof createAuth>;
// Private identity of a connection: never part of domain events or responses.
export type Credential =
  | AgentKeyCredential
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
export async function authorizeRequest(
  db: DatabaseHandle,
  auth: Auth,
  request: Request,
  { readOnly = false }: { readOnly?: boolean } = {},
): Promise<Authorized | null> {
  const bearer = request.headers.get('authorization');
  const token =
    bearer?.match(/^Bearer\s+(.+)$/i)?.[1] ?? request.headers.get('x-api-key');
  if (token) {
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
