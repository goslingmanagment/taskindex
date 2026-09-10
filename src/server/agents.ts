import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from './db.js';
import * as schema from './schema.js';
import { issueAgentKey } from './agent-keys.js';
import type { Scope } from '../shared/model.js';
import { fail } from '../shared/errors.js';
import { idSchema, z } from '../shared/schemas.js';
import { LIMITS } from '../shared/limits.js';

export function createAgent(
  db: DatabaseHandle,
  input: { id: string; label: string },
) {
  idSchema.parse(input.id);
  z.string().trim().min(1).max(LIMITS.agentLabel).parse(input.label);
  if (
    db.orm
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, input.id))
      .get()
  )
    fail('conflict', 'Агент с таким id уже существует.');
  const row = {
    id: input.id,
    label: input.label.trim(),
    createdAt: new Date().toISOString(),
    disabledAt: null,
  };
  db.orm.insert(schema.agents).values(row).run();
  return row;
}
export function listAgents(db: DatabaseHandle) {
  return db.orm.select().from(schema.agents).all();
}
export function disableAgent(db: DatabaseHandle, id: string) {
  if (
    !db.orm.select().from(schema.agents).where(eq(schema.agents.id, id)).get()
  )
    fail('not_found', 'Агент не найден.');
  db.orm
    .update(schema.agents)
    .set({ disabledAt: new Date().toISOString() })
    .where(eq(schema.agents.id, id))
    .run();
  return { ok: true };
}
export function createAgentKey(
  db: DatabaseHandle,
  input: { agentId: string; scope: Scope; name?: string },
) {
  return issueAgentKey(db, input);
}
