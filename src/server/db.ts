import { and, asc, eq, gt, or } from 'drizzle-orm';
import * as schema from './schema.js';
import type { DatabaseHandle } from './sqlite.js';
// One module path for the data layer: the connection and settings live in
// sqlite.ts, the migration chain in migrations.ts, the event journal in
// events.ts, the operation journal in journal.ts, the workspace itself here.
export * from './sqlite.js';
export * from './migrations.js';
export * from './events.js';
export * from './journal.js';
import type {
  Comment,
  EntityKind,
  WorkspaceState,
  Task,
  Project,
  Appearance,
} from '../shared/model.js';
import { defaultAppearance } from '../shared/domain-schemas.js';
import { DEFAULT_APPEARANCE_ID } from '../shared/appearance.js';

type ChecklistRow = typeof schema.checklistItems.$inferSelect;
const toChecklist = (rows: ChecklistRow[]) =>
  rows.map(({ taskId: _taskId, position: _position, ...i }) => i);
const toTask = (
  row: typeof schema.tasks.$inferSelect,
  checklist: ChecklistRow[],
  commentCount: number,
): Task =>
  ({ ...row, checklist: toChecklist(checklist), commentCount }) as Task;
export function readProjects(db: DatabaseHandle): Project[] {
  return db.orm
    .select()
    .from(schema.projects)
    .all()
    .map(({ nameKey: _nameKey, ...p }) => p as Project);
}
function readAppearance(db: DatabaseHandle): Appearance {
  // A workspace whose owner never chose anything has no row: the default
  // preference is what every reader sees, and revision 1 is its baseRevision.
  return (db.orm
    .select()
    .from(schema.appearance)
    .where(eq(schema.appearance.id, DEFAULT_APPEARANCE_ID))
    .get() ?? defaultAppearance()) as Appearance;
}
// Steps and comment counts are grouped by task in one pass each: the cost is
// the size of the workspace, not tasks × (steps + comments).
export function readState(db: DatabaseHandle): WorkspaceState {
  const projects = readProjects(db);
  const comments = db.orm.select().from(schema.comments).all();
  const items = Map.groupBy(
    db.orm
      .select()
      .from(schema.checklistItems)
      .orderBy(asc(schema.checklistItems.position))
      .all(),
    (i) => i.taskId,
  );
  const counts = new Map<string, number>();
  for (const c of comments)
    if (!c.deletedAt) counts.set(c.taskId, (counts.get(c.taskId) ?? 0) + 1);
  const tasks = db.orm
    .select()
    .from(schema.tasks)
    .all()
    .map((t) => toTask(t, items.get(t.id) ?? [], counts.get(t.id) ?? 0));
  return { projects, tasks, comments, appearance: [readAppearance(db)] };
}
// Point reads for the routes that need one record (plan 01, step 4).
export function readTask(db: DatabaseHandle, id: string): Task | undefined {
  const row = db.orm
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
    .get();
  if (!row) return undefined;
  const checklist = db.orm
    .select()
    .from(schema.checklistItems)
    .where(eq(schema.checklistItems.taskId, id))
    .orderBy(asc(schema.checklistItems.position))
    .all();
  const count = db.sqlite
    .prepare(
      'SELECT COUNT(*) AS n FROM comments WHERE task_id=? AND deleted_at IS NULL',
    )
    .get(id) as { n: number };
  return toTask(row, checklist, count.n);
}
export function readTaskByOrigin(
  db: DatabaseHandle,
  system: string,
  ref: string,
): Task | undefined {
  const row = db.orm
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.originSystem, system),
        eq(schema.tasks.originRef, ref),
      ),
    )
    .get();
  return row ? readTask(db, row.id) : undefined;
}
export function taskExists(db: DatabaseHandle, id: string): boolean {
  return (
    db.orm
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
      .get() !== undefined
  );
}
// Comments of one task in (createdAt, id) order, keyset by the same pair
// (index comments_task_created). Without `page` the whole thread.
export function readComments(
  db: DatabaseHandle,
  taskId: string,
  page?: { after?: { createdAt: string; id: string }; limit: number },
): Comment[] {
  const after = page?.after;
  const query = db.orm
    .select()
    .from(schema.comments)
    .where(
      and(
        eq(schema.comments.taskId, taskId),
        ...(after
          ? [
              or(
                gt(schema.comments.createdAt, after.createdAt),
                and(
                  eq(schema.comments.createdAt, after.createdAt),
                  gt(schema.comments.id, after.id),
                ),
              ),
            ]
          : []),
      ),
    )
    .orderBy(asc(schema.comments.createdAt), asc(schema.comments.id));
  return page ? query.limit(page.limit).all() : query.all();
}
// Which records a packet changed, from its events: every change of a subject
// or bookkeeping field passes through `emit`, so the effects name every row
// `writeState` has to touch (plan 01, step 6).
export type Touched = {
  projects: Set<string>;
  tasks: Set<string>;
  comments: Set<string>;
  appearance: boolean;
};
export function touchedByEvents(
  events: { entityKind: EntityKind; entityId: string }[],
): Touched {
  const touched: Touched = {
    projects: new Set(),
    tasks: new Set(),
    comments: new Set(),
    appearance: false,
  };
  for (const e of events)
    if (e.entityKind === 'task') touched.tasks.add(e.entityId);
    else if (e.entityKind === 'project') touched.projects.add(e.entityId);
    else if (e.entityKind === 'comment') touched.comments.add(e.entityId);
    else touched.appearance = true;
  return touched;
}
// Persists the records that differ from `previous`: named by `touched` when
// the caller knows them (the executor), found by a JSON diff otherwise
// (import writes everything, tests compare the two paths).
export function writeState(
  db: DatabaseHandle,
  state: WorkspaceState,
  previous?: WorkspaceState,
  touched?: Touched,
) {
  const byId = <T extends { id: string }>(rows: T[] | undefined) =>
    new Map((rows ?? []).map((r) => [r.id, r]));
  const differs = <T extends { id: string }>(
    rows: T[],
    before: Map<string, T>,
    named?: Set<string>,
  ) =>
    rows.filter((r) =>
      named
        ? named.has(r.id)
        : !previous || JSON.stringify(before.get(r.id)) !== JSON.stringify(r),
    );
  const previousProjects = byId(previous?.projects);
  const changedProjects = differs(
    state.projects,
    previousProjects,
    touched?.projects,
  );
  for (const p of changedProjects)
    if (previousProjects.has(p.id))
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
  const previousTasks = byId(previous?.tasks);
  const changed = differs(state.tasks, previousTasks, touched?.tasks);
  // Free affected order slots before restoring several positions in one transaction.
  for (const t of changed)
    if (previousTasks.has(t.id))
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
    (touched
      ? touched.appearance
      : JSON.stringify(previous?.appearance[0]) !== JSON.stringify(appearance))
  )
    db.orm
      .insert(schema.appearance)
      .values(appearance)
      .onConflictDoUpdate({ target: schema.appearance.id, set: appearance })
      .run();
  for (const c of differs(
    state.comments,
    byId(previous?.comments),
    touched?.comments,
  ))
    db.orm
      .insert(schema.comments)
      .values(c)
      .onConflictDoUpdate({ target: schema.comments.id, set: c })
      .run();
}
