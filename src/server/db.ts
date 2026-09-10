import { eq, asc, gt } from 'drizzle-orm';
import * as schema from './schema.js';
import type { DatabaseHandle } from './sqlite.js';
import { generation } from './sqlite.js';
// One module path for the data layer: the connection and settings live in
// sqlite.ts, the migration chain in migrations.ts, the workspace itself here.
export * from './sqlite.js';
export * from './migrations.js';
import type {
  DomainEvent,
  OperationResponse,
  OperationSuccess,
  WorkspaceState,
  Task,
  Project,
  Appearance,
  StoredOperation,
} from '../shared/model.js';
import type { StoredResult } from './schema.js';
import { defaultAppearance } from '../shared/domain-schemas.js';
import { DEFAULT_APPEARANCE_ID } from '../shared/appearance.js';
// Events of one operation straight from the journal (index events_operation).
export function readEventsForOperation(
  db: DatabaseHandle,
  operationId: string,
): DomainEvent[] {
  const gen = generation(db);
  return db.orm
    .select()
    .from(schema.events)
    .where(eq(schema.events.operationId, operationId))
    .orderBy(asc(schema.events.seq))
    .all()
    .map(
      ({ taskId, ...e }) =>
        ({
          ...e,
          generation: gen,
          ...(taskId ? { taskId } : {}),
        }) as DomainEvent,
    );
}
// The result as clients see it: a success stored without its events gets them
// back from the journal, a row of the older format keeps its own copy.
export function withEvents(
  result: StoredResult,
  events: DomainEvent[],
): OperationResponse {
  if (!result.ok) return result;
  return result.events ? (result as OperationSuccess) : { ...result, events };
}
export function withoutEvents(result: OperationResponse): StoredResult {
  if (!result.ok) return result;
  const { events: _events, ...rest } = result;
  return rest;
}
export function readState(db: DatabaseHandle): WorkspaceState {
  const projects = db.orm
    .select()
    .from(schema.projects)
    .all()
    .map(({ nameKey: _nameKey, ...p }) => p as Project);
  const comments = db.orm.select().from(schema.comments).all();
  const items = db.orm
    .select()
    .from(schema.checklistItems)
    .orderBy(asc(schema.checklistItems.position))
    .all();
  const tasks = db.orm
    .select()
    .from(schema.tasks)
    .all()
    .map(
      (t) =>
        ({
          ...t,
          checklist: items
            .filter((i) => i.taskId === t.id)
            .map(({ taskId: _taskId, position: _position, ...i }) => i),
          commentCount: comments.filter(
            (c) => c.taskId === t.id && !c.deletedAt,
          ).length,
        }) as Task,
    );
  // A workspace whose owner never chose anything has no row: the default
  // preference is what every reader sees, and revision 1 is its baseRevision.
  const appearance = (db.orm
    .select()
    .from(schema.appearance)
    .where(eq(schema.appearance.id, DEFAULT_APPEARANCE_ID))
    .get() ?? defaultAppearance()) as Appearance;
  return { projects, tasks, comments, appearance: [appearance] };
}
export function readEvents(
  db: DatabaseHandle,
  since = 0,
  limit?: number,
): DomainEvent[] {
  const query = db.orm
    .select()
    .from(schema.events)
    .where(gt(schema.events.seq, since))
    .orderBy(asc(schema.events.seq));
  const rows = limit ? query.limit(limit).all() : query.all();
  const gen = generation(db);
  return rows.map(
    ({ taskId, ...e }) =>
      ({ ...e, generation: gen, ...(taskId ? { taskId } : {}) }) as DomainEvent,
  );
}
export function writeState(
  db: DatabaseHandle,
  state: WorkspaceState,
  previous?: WorkspaceState,
) {
  const changedProjects = state.projects.filter(
    (p) =>
      !previous ||
      JSON.stringify(previous.projects.find((before) => before.id === p.id)) !==
        JSON.stringify(p),
  );
  for (const p of changedProjects)
    if (previous?.projects.some((before) => before.id === p.id))
      db.orm
        .update(schema.projects)
        .set({ nameKey: `${'_'.repeat(61)}${p.id}` })
        .where(eq(schema.projects.id, p.id))
        .run();
  for (const p of changedProjects) {
    const row = { ...p, nameKey: p.name.toLocaleLowerCase('ru').trim() };
    db.orm
      .insert(schema.projects)
      .values(row)
      .onConflictDoUpdate({ target: schema.projects.id, set: row })
      .run();
  }
  const changed = state.tasks.filter(
    (t) =>
      !previous ||
      JSON.stringify(previous.tasks.find((p) => p.id === t.id)) !==
        JSON.stringify(t),
  );
  // Free affected order slots before restoring several positions in one transaction.
  for (const t of changed)
    if (previous?.tasks.some((p) => p.id === t.id))
      db.orm
        .update(schema.tasks)
        .set({ orderKey: `~${t.id}` })
        .where(eq(schema.tasks.id, t.id))
        .run();
  for (const t of changed)
    db.orm
      .delete(schema.checklistItems)
      .where(eq(schema.checklistItems.taskId, t.id))
      .run();
  for (const t of changed) {
    const { checklist, commentCount: _count, ...row } = t;
    db.orm
      .insert(schema.tasks)
      .values(row)
      .onConflictDoUpdate({ target: schema.tasks.id, set: row })
      .run();
    for (const [position, item] of checklist.entries())
      db.orm
        .insert(schema.checklistItems)
        .values({ ...item, taskId: t.id, position })
        .run();
  }
  const appearance = state.appearance[0];
  if (
    appearance &&
    JSON.stringify(previous?.appearance[0]) !== JSON.stringify(appearance)
  )
    db.orm
      .insert(schema.appearance)
      .values(appearance)
      .onConflictDoUpdate({ target: schema.appearance.id, set: appearance })
      .run();
  for (const c of state.comments.filter(
    (c) =>
      !previous ||
      JSON.stringify(previous.comments.find((before) => before.id === c.id)) !==
        JSON.stringify(c),
  ))
    db.orm
      .insert(schema.comments)
      .values(c)
      .onConflictDoUpdate({ target: schema.comments.id, set: c })
      .run();
}
export function readOperations(
  db: DatabaseHandle,
): (StoredOperation & { operationSeq: number; commandHash: string })[] {
  const rows = db.orm
    .select()
    .from(schema.operations)
    .orderBy(asc(schema.operations.operationSeq))
    .all();
  // One scan of the journal, grouped by operation, instead of parsing the
  // events out of every stored result.
  const journal = rows.some((o) => o.result.ok && !o.result.events)
    ? Map.groupBy(readEvents(db), (e) => e.operationId)
    : new Map<string, DomainEvent[]>();
  return rows.map((o) => {
    const result = withEvents(o.result, journal.get(o.id) ?? []);
    const ev = result.ok ? result.events : [];
    const ids = [
      ...new Set(
        ev.flatMap((e) =>
          e.entityKind === 'task' ? [e.entityId] : e.taskId ? [e.taskId] : [],
        ),
      ),
    ];
    const titles = ids
      .slice(0, 3)
      .map(
        (id) =>
          db.orm
            .select({ title: schema.tasks.title })
            .from(schema.tasks)
            .where(eq(schema.tasks.id, id))
            .get()?.title ?? id,
      );
    return {
      ...o,
      result,
      ok: result.ok,
      ...(!result.ok
        ? { errorCode: result.code, errorMessage: result.message }
        : {}),
      taskCount: ids.length,
      titles,
    };
  });
}
