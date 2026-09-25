import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from './db.js';
import * as schema from './schema.js';
import type { Actor, Scope } from '../shared/model.js';
import { fail } from '../shared/errors.js';
import { z } from '../shared/schemas.js';
const scopeSchema = z.enum(['read', 'propose', 'tasks', 'write']);
// SHA-256 → base64url without padding: the same function the former Better Auth
// api-key plugin used (`defaultKeyHasher`), so migrated hashes keep working.
/** @internal for tests */
export const hashAgentKey = (token: string) =>
  createHash('sha256').update(token).digest('base64url');
export type AgentKeyCredential = {
  kind: 'agent-key';
  keyId: string;
  agentId: string;
};
export function issueAgentKey(
  db: DatabaseHandle,
  input: { agentId: string; scope: Scope; name?: string },
): { id: string; key: string; agentId: string; scope: Scope } {
  const scope = scopeSchema.parse(input.scope);
  const agent = db.orm
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, input.agentId))
    .get();
  if (!agent || agent.disabledAt)
    fail('forbidden', 'Агент не найден или отключён.');
  const key = `ti_${randomBytes(32).toString('base64url')}`;
  const row = {
    id: randomUUID(),
    agentId: agent.id,
    scope,
    keyHash: hashAgentKey(key),
    name: input.name ?? agent.label,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };
  db.orm.insert(schema.agentKeys).values(row).run();
  return { id: row.id, key, agentId: agent.id, scope };
}
const keyWithAgent = {
  id: schema.agentKeys.id,
  agentId: schema.agentKeys.agentId,
  scope: schema.agentKeys.scope,
  keyHash: schema.agentKeys.keyHash,
  revokedAt: schema.agentKeys.revokedAt,
  label: schema.agents.label,
  disabledAt: schema.agents.disabledAt,
};
// One indexed read, no writes: checking a key must not touch the database
// (deploy gate `writes: held`, Litestream replication, SSE rechecks).
export function verifyAgentKey(
  db: DatabaseHandle,
  token: string,
): { actor: Actor; credential: AgentKeyCredential } {
  const hash = hashAgentKey(token);
  const row = db.orm
    .select(keyWithAgent)
    .from(schema.agentKeys)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.agentKeys.agentId))
    .where(eq(schema.agentKeys.keyHash, hash))
    .get();
  const stored = Buffer.from(row?.keyHash ?? '');
  const given = Buffer.from(hash);
  if (
    !row ||
    row.revokedAt ||
    stored.length !== given.length ||
    !timingSafeEqual(stored, given)
  )
    fail('forbidden', 'Ключ недействителен или отозван.');
  if (row.disabledAt) fail('forbidden', 'Агент отключён.');
  return {
    actor: {
      id: `agent:${row.agentId}`,
      agentId: row.agentId,
      label: row.label,
      kind: 'agent',
      scope: row.scope,
    },
    credential: { kind: 'agent-key', keyId: row.id, agentId: row.agentId },
  };
}
// Is an already-verified key still usable? Same read path, no writes.
export function agentKeyIsActive(db: DatabaseHandle, keyId: string): boolean {
  const row = db.orm
    .select({
      revokedAt: schema.agentKeys.revokedAt,
      disabledAt: schema.agents.disabledAt,
    })
    .from(schema.agentKeys)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.agentKeys.agentId))
    .where(eq(schema.agentKeys.id, keyId))
    .get();
  return Boolean(row) && row!.revokedAt === null && row!.disabledAt === null;
}
export function listAgentKeys(db: DatabaseHandle, agentId?: string) {
  return db.orm
    .select({
      id: schema.agentKeys.id,
      agentId: schema.agentKeys.agentId,
      scope: schema.agentKeys.scope,
      name: schema.agentKeys.name,
      createdAt: schema.agentKeys.createdAt,
      revokedAt: schema.agentKeys.revokedAt,
    })
    .from(schema.agentKeys)
    .all()
    .filter((k) => !agentId || k.agentId === agentId);
}
export function revokeAgentKey(db: DatabaseHandle, id: string) {
  const key = db.orm
    .select({ revokedAt: schema.agentKeys.revokedAt })
    .from(schema.agentKeys)
    .where(eq(schema.agentKeys.id, id))
    .get();
  if (!key) fail('not_found', 'Ключ не найден.');
  if (!key.revokedAt)
    db.orm
      .update(schema.agentKeys)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(schema.agentKeys.id, id))
      .run();
  return { ok: true as const };
}
