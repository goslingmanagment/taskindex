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
  Label,
  Appearance,
  Step,
} from '../shared/model.js';
import { defaultAppearance } from '../shared/domain-schemas.js';
import { DEFAULT_APPEARANCE_ID } from '../shared/appearance.js';
import { projectChecklist } from '../shared/steps.js';

// A step row is the step record (0008): the codec is the identity.
const toStep = (row: typeof schema.checklistItems.$inferSelect): Step =>
  row as Step;
const toTask = (
  row: typeof schema.tasks.$inferSelect,
  steps: readonly Step[],
  commentCount: number,
): Task =>
  ({
    ...row,
    checklist: projectChecklist(steps, row.id),
    commentCount,
  }) as Task;
// The row codecs of the workspace (plan 10, step 10): a project row drops
// its search key, a task row gains the projection of its steps and its
// comment count.
const toProject = ({
  nameKey: _nameKey,
  ...p
}: typeof schema.projects.$inferSelect): Project => p as Project;
export function readProjects(db: DatabaseHandle): Project[] {
  return db.orm.select().from(schema.projects).all().map(toProject);
}
const toLabel = ({
  nameKey: _nameKey,
  ...l
}: typeof schema.labels.$inferSelect): Label => l as Label;
export function readLabels(db: DatabaseHandle): Label[] {
  return db.orm
    .select()
    .from(schema.labels)
    .orderBy(asc(schema.labels.position))
    .all()
    .map(toLabel);
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
  const labels = readLabels(db);
  const comments = db.orm.select().from(schema.comments).all();
  const steps = db.orm.select().from(schema.checklistItems).all().map(toStep);
  const byTask = Map.groupBy(steps, (s) => s.taskId);
  const counts = new Map<string, number>();
  for (const c of comments)
    if (!c.deletedAt) counts.set(c.taskId, (counts.get(c.taskId) ?? 0) + 1);
  const tasks = db.orm
    .select()
    .from(schema.tasks)
    .all()
    .map((t) => toTask(t, byTask.get(t.id) ?? [], counts.get(t.id) ?? 0));
  return {
    projects,
    labels,
    tasks,
    steps,
    comments,
    // A proposal row is the proposal record (0009).
    proposals: db.orm.select().from(schema.proposals).all(),
    appearance: [readAppearance(db)],
  };
}
// Point reads for the routes that need one record (plan 01, step 4).
export function readTask(db: DatabaseHandle, id: string): Task | undefined {
  const row = db.orm
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
    .get();
  if (!row) return undefined;
  const steps = db.orm
    .select()
    .from(schema.checklistItems)
    .where(eq(schema.checklistItems.taskId, id))
    .all()
    .map(toStep);
  const count = db.sqlite
    .prepare(
      'SELECT COUNT(*) AS n FROM comments WHERE task_id=? AND deleted_at IS NULL',
    )
    .get(id) as { n: number };
  return toTask(row, steps, count.n);
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
  labels: Set<string>;
  tasks: Set<string>;
  steps: Set<string>;
  comments: Set<string>;
  proposals: Set<string>;
  appearance: boolean;
};
export function touchedByEvents(
  events: { entityKind: EntityKind; entityId: string }[],
): Touched {
  const touched: Touched = {
    projects: new Set(),
    labels: new Set(),
    tasks: new Set(),
    steps: new Set(),
    comments: new Set(),
    proposals: new Set(),
    appearance: false,
  };
  for (const e of events)
    if (e.entityKind === 'task') touched.tasks.add(e.entityId);
    else if (e.entityKind === 'project') touched.projects.add(e.entityId);
    else if (e.entityKind === 'label') touched.labels.add(e.entityId);
    else if (e.entityKind === 'comment') touched.comments.add(e.entityId);
    else if (e.entityKind === 'step') touched.steps.add(e.entityId);
    else if (e.entityKind === 'proposal') touched.proposals.add(e.entityId);
    else touched.appearance = true;
  return touched;
}
// Persists the records that differ from `previous`: named by `touched` when
// the caller knows them (the executor), found by a JSON diff otherwise
// (import writes everything, tests compare the two paths).
const byId = <T extends { id: string }>(rows: T[] | undefined) =>
  new Map((rows ?? []).map((r) => [r.id, r]));
export function writeState(
  db: DatabaseHandle,
  state: WorkspaceState,
  previous?: WorkspaceState,
  touched?: Touched,
) {
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
  // Labels: the same two passes as projects, because two active labels may
  // swap names inside one operation and the active-name index is unique.
  const previousLabels = byId(previous?.labels);
  const changedLabels = differs(state.labels, previousLabels, touched?.labels);
  for (const l of changedLabels)
    if (previousLabels.has(l.id))
      db.orm
        .update(schema.labels)
        .set({ nameKey: `${'_'.repeat(61)}${l.id}` })
        .where(eq(schema.labels.id, l.id))
        .run();
  for (const l of changedLabels) {
    const row = { ...l, nameKey: l.name.toLocaleLowerCase('ru').trim() };
    db.orm
      .insert(schema.labels)
      .values(row)
      .onConflictDoUpdate({ target: schema.labels.id, set: row })
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
  for (const t of changed) {
    // The checklist is a projection of the step rows, never stored.
    const { checklist: _checklist, commentCount: _count, ...row } = t;
    db.orm
      .insert(schema.tasks)
      .values(row)
      .onConflictDoUpdate({ target: schema.tasks.id, set: row })
      .run();
  }
  // Steps after tasks (a promoted step points at a task written just above).
  // Free the order slots of the changed steps first: several steps may swap
  // places in one operation under the unique (task_id, order_key) index.
  const previousSteps = byId(previous?.steps);
  const changedSteps = differs(state.steps, previousSteps, touched?.steps);
  for (const s of changedSteps)
    if (previousSteps.has(s.id))
      db.orm
        .update(schema.checklistItems)
        .set({ orderKey: `~${s.id}` })
        .where(eq(schema.checklistItems.id, s.id))
        .run();
  for (const s of changedSteps)
    db.orm
      .insert(schema.checklistItems)
      .values(s)
      .onConflictDoUpdate({ target: schema.checklistItems.id, set: s })
      .run();
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
  // Proposals after tasks (they point at them). One delivery may free a
  // number and give it to another proposal: the numbers of the changed rows
  // are released first, under the unique index of shown numbers.
  const previousProposals = byId(previous?.proposals);
  const changedProposals = differs(
    state.proposals,
    previousProposals,
    touched?.proposals,
  );
  for (const p of changedProposals)
    if (previousProposals.has(p.id) && previousProposals.get(p.id)!.number)
      db.orm
        .update(schema.proposals)
        .set({ number: null })
        .where(eq(schema.proposals.id, p.id))
        .run();
  for (const p of changedProposals)
    db.orm
      .insert(schema.proposals)
      .values(p)
      .onConflictDoUpdate({ target: schema.proposals.id, set: p })
      .run();
}
