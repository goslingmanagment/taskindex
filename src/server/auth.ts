import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { apiKey } from '@better-auth/api-key';
import { passkey } from '@better-auth/passkey';
import { eq } from 'drizzle-orm';
import * as schema from './schema.js';
import type { DatabaseHandle } from './db.js';
import type { Actor } from '../shared/model.js';
import { fail } from '../shared/errors.js';
export function createAuth(
  db: DatabaseHandle,
  options: { baseURL: string; secret: string; trustedOrigins?: string[] },
) {
  return betterAuth({
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
      apiKey({
        enableMetadata: true,
        enableSessionForAPIKeys: false,
        customAPIKeyGetter: (ctx) =>
          ctx.headers?.get('authorization')?.replace(/^Bearer\s+/i, '') ??
          ctx.headers?.get('x-api-key') ??
          null,
      }),
      passkey({
        rpID: new URL(options.baseURL).hostname,
        rpName: 'TaskIndex',
        origin: options.trustedOrigins ?? [options.baseURL],
      }),
    ],
  });
}
export type Auth = ReturnType<typeof createAuth>;
export async function authorizeRequest(
  db: DatabaseHandle,
  auth: Auth,
  request: Request,
): Promise<Actor | null> {
  const bearer = request.headers.get('authorization');
  const token =
    bearer?.match(/^Bearer\s+(.+)$/i)?.[1] ?? request.headers.get('x-api-key');
  if (token) {
    const verified = await auth.api.verifyApiKey({ body: { key: token } });
    if (!verified.valid || !verified.key)
      fail('forbidden', 'Ключ недействителен или отозван.');
    const key = db.orm
      .select()
      .from(schema.apikey)
      .where(eq(schema.apikey.id, verified.key.id))
      .get();
    if (!key?.agentId || !['read', 'tasks', 'write'].includes(key.scope ?? ''))
      fail('forbidden', 'Ключ не связан с агентом.');
    const agent = db.orm
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, key.agentId))
      .get();
    if (!agent || agent.disabledAt) fail('forbidden', 'Агент отключён.');
    return {
      id: `agent:${agent.id}`,
      agentId: agent.id,
      label: agent.label,
      kind: 'agent',
      scope: key.scope as Actor['scope'],
    };
  }
  const s = await auth.api.getSession({ headers: request.headers });
  if (!s || s.user.id !== 'owner') return null;
  return { id: 'owner', label: s.user.name, kind: 'owner', scope: 'write' };
}
