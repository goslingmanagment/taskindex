import SQLite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, asc, gt } from 'drizzle-orm';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as schema from './schema.js';
import { SCHEMA_VERSION } from '../shared/model.js';
import type {
  DomainEvent,
  WorkspaceState,
  Task,
  Project,
  StoredOperation,
} from '../shared/model.js';
import { fail } from '../shared/errors.js';
export function openDatabase(path: string) {
  if (path !== ':memory:')
    mkdirSync(dirname(resolve(path)), { recursive: true });
  const sqlite = new SQLite(path);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = FULL');
  sqlite.pragma('busy_timeout = 5000');
  const orm = drizzle(sqlite, { schema });
  return { sqlite, orm, close: () => sqlite.close() };
}
export type DatabaseHandle = ReturnType<typeof openDatabase>;
export function getSetting(
  db: DatabaseHandle,
  key: string,
): string | undefined {
  return db.orm
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, key))
    .get()?.value;
}
export function setSetting(db: DatabaseHandle, key: string, value: string) {
  db.orm
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run();
}
export function migrate(
  db: DatabaseHandle,
  options: { timezone?: string; migrationsDir?: string } = {},
) {
  db.sqlite
    .transaction(() => {
      const migrations = resolve(options.migrationsDir ?? 'drizzle/v2');
      const names = readdirSync(migrations)
        .filter((n) => n.endsWith('.sql'))
        .sort();
      const hasSettings = db.sqlite
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'",
        )
        .get();
      if (
        hasSettings &&
        Number(getSetting(db, 'schema_version') ?? 0) > SCHEMA_VERSION
      )
        fail(
          'unavailable',
          'Нельзя применить старый migrator к более новой схеме.',
        );
      db.sqlite.exec(
        'CREATE TABLE IF NOT EXISTS __taskindex_migrations(name TEXT PRIMARY KEY NOT NULL)',
      );
      const applied = db.sqlite
        .prepare('SELECT name FROM __taskindex_migrations')
        .all() as { name: string }[];
      if (applied.some((m) => !names.includes(m.name)))
        fail('unavailable', 'В базе есть неизвестные этому образу миграции.');
      for (const name of names) {
        if (
          !db.sqlite
            .prepare('SELECT 1 FROM __taskindex_migrations WHERE name=?')
            .get(name)
        ) {
          db.sqlite.exec(readFileSync(resolve(migrations, name), 'utf8'));
          db.sqlite
            .prepare('INSERT INTO __taskindex_migrations(name) VALUES(?)')
            .run(name);
        }
      }
      if (!getSetting(db, 'generation'))
        setSetting(db, 'generation', randomUUID());
      if (!getSetting(db, 'timezone'))
        setSetting(db, 'timezone', options.timezone ?? 'Europe/Moscow');
      setSetting(db, 'schema_version', String(SCHEMA_VERSION));
    })
    .immediate();
}
export const initializeDatabase = migrate;
export function assertSchema(db: DatabaseHandle) {
  if (getSetting(db, 'schema_version') !== String(SCHEMA_VERSION))
    fail(
      'unavailable',
      'Схема базы не соответствует образу. Запустите миграции подходящим образом.',
    );
}
export function generation(db: DatabaseHandle) {
  return (
    getSetting(db, 'generation') ??
    fail('unavailable', 'База не инициализирована.')
  );
}
export function latestSeq(db: DatabaseHandle): number {
  return (
    db.sqlite.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events').get() as {
      n: number;
    }
  ).n;
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
  return { projects, tasks, comments };
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
): (StoredOperation & { commandHash: string })[] {
  return db.orm
    .select()
    .from(schema.operations)
    .orderBy(asc(schema.operations.createdAt), asc(schema.operations.id))
    .all()
    .map((o) => {
      const result = o.result;
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
        ok: result.ok,
        ...(!result.ok
          ? { errorCode: result.code, errorMessage: result.message }
          : {}),
        taskCount: ids.length,
        titles,
      };
    });
}
