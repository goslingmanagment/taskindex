import { eq, or, sql } from 'drizzle-orm';
import type { DatabaseHandle } from './db.js';
import { withWrite } from './sqlite.js';
import * as schema from './schema.js';
import { issueAgentKey } from './agent-keys.js';
import type { ChecklistItem, EntityKind, Scope } from '../shared/model.js';
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
// Cards, their steps and comments carry the label the agent had when it wrote
// or ticked them; a rename rewrites those snapshots so the board reads one
// name. The events and operations journals keep the label of their time, and
// validateExport reads an agent's snapshot as the agent (src/server/backup.ts).
export function renameAgent(
  db: DatabaseHandle,
  input: { id: string; label: string },
) {
  const label = z
    .string()
    .trim()
    .min(1)
    .max(LIMITS.agentLabel)
    .parse(input.label);
  const actorId = `agent:${input.id}`;
  return withWrite(db, () => {
    if (
      !db.orm
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, input.id))
        .get()
    )
      fail('not_found', 'Агент не найден.');
    db.orm
      .update(schema.agents)
      .set({ label })
      .where(eq(schema.agents.id, input.id))
      .run();
    const tasks = db.orm
      .update(schema.tasks)
      .set({ createdByLabel: label })
      .where(eq(schema.tasks.createdBy, actorId))
      .run().changes;
    const comments = db.orm
      .update(schema.comments)
      .set({ actorLabel: label })
      .where(eq(schema.comments.actorId, actorId))
      .run().changes;
    // One statement, so a step the agent both wrote and ticked counts once.
    const step = schema.checklistItems;
    const steps = db.orm
      .update(step)
      .set({
        createdByLabel: sql`CASE WHEN ${step.createdBy} = ${actorId} THEN ${label} ELSE ${step.createdByLabel} END`,
        doneByLabel: sql`CASE WHEN ${step.doneBy} = ${actorId} THEN ${label} ELSE ${step.doneByLabel} END`,
      })
      .where(or(eq(step.createdBy, actorId), eq(step.doneBy, actorId)))
      .run().changes;
    return { id: input.id, label, tasks, comments, steps };
  });
}
// The name snapshots a rename rewrites, each next to the author field it
// belongs to. The owner's name is never rewritten outside the journal.
const SNAPSHOTS: Partial<Record<EntityKind, Record<string, string>>> = {
  task: { createdByLabel: 'createdBy' },
  step: { createdByLabel: 'createdBy', doneByLabel: 'doneBy' },
  comment: { actorLabel: 'actorId' },
};
// validateExport compares the tables with the journal replay: a name snapshot
// of an agent of the export reads as the agent itself, whatever name it had.
export function agentSnapshots(agents: readonly { id: string }[]) {
  const renamable = new Set(agents.map((a) => `agent:${a.id}`));
  const value = (kind: EntityKind, key: string, row: object, v: unknown) => {
    const author = SNAPSHOTS[kind]?.[key];
    const actor = author && (row as Record<string, unknown>)[author];
    return v !== null && typeof actor === 'string' && renamable.has(actor)
      ? actor
      : v;
  };
  const record = <T extends object>(kind: EntityKind, row: T): T => {
    const copy: Record<string, unknown> = { ...(row as object) };
    for (const key of Object.keys(SNAPSHOTS[kind] ?? {}))
      if (key in copy) copy[key] = value(kind, key, row, copy[key]);
    // The task shows the ticks of its steps through the checklist projection.
    if (kind === 'task' && Array.isArray(copy.checklist))
      copy.checklist = (copy.checklist as ChecklistItem[]).map((item) =>
        record('step', item),
      );
    return copy as unknown as T;
  };
  return { value, record };
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
