import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { passkey } from '@better-auth/passkey';
import * as schema from './schema.js';
import type { DatabaseHandle } from './db.js';
import type { Actor } from '../shared/model.js';
import { agentKeyIsActive, verifyAgentKey } from './agent-keys.js';
import type { AgentKeyCredential } from './agent-keys.js';
export function createAuth(
  db: DatabaseHandle,
  options: { baseURL: string; secret: string; trustedOrigins?: string[] },
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
  return { ...auth, readSession: readOnly.api.getSession };
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
        current.session.id === s.session.id,
      );
    },
  };
}
