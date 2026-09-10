import SQLite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, asc, gt } from 'drizzle-orm';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import * as schema from './schema.js';
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
export type MigrationLogger = {
  warn: (fields: Record<string, unknown>) => void;
};
const defaultMigrationLogger: MigrationLogger = {
  warn: (fields) =>
    console.warn(
      JSON.stringify({
        level: 'warn',
        time: new Date().toISOString(),
        ...fields,
      }),
    ),
};
// Migrations ship next to the code: <root>/drizzle/v2 both from src/server and
// from dist/server or dist/cli, so the working directory does not matter.
export function migrationsDirectory(override?: string): string {
  return resolve(
    override ?? fileURLToPath(new URL('../../drizzle/v2', import.meta.url)),
  );
}
export type BundledMigration = { name: string; sha256: string };
// Hash of the file bytes with CRLF normalised to LF, so a checkout with
// different line endings still describes the same migration.
export function bundledMigrations(dir: string): BundledMigration[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(dir, name), 'utf8').replace(/\r\n/g, '\n'))
        .digest('hex'),
    }));
}
export function schemaVersion(migrationsDir?: string): number {
  return bundledMigrations(migrationsDirectory(migrationsDir)).length;
}
type JournalRow = { name: string; sha256: string | null };
function readJournal(db: DatabaseHandle): JournalRow[] | undefined {
  const columns = db.sqlite.pragma('table_info(__taskindex_migrations)') as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === 'sha256')) return undefined;
  return db.sqlite
    .prepare('SELECT name, sha256 FROM __taskindex_migrations ORDER BY name')
    .all() as JournalRow[];
}
const changedMigration = (name: string) =>
  fail(
    'unavailable',
    `Содержимое применённой миграции ${name} изменено. Применённые SQL-файлы редактировать нельзя: восстановите файл или добавьте новую миграцию.`,
  );
export function migrate(
  db: DatabaseHandle,
  options: {
    timezone?: string;
    migrationsDir?: string;
    logger?: MigrationLogger;
  } = {},
) {
  const dir = migrationsDirectory(options.migrationsDir);
  const bundled = bundledMigrations(dir);
  const version = bundled.length;
  const logger = options.logger ?? defaultMigrationLogger;
  db.sqlite
    .transaction(() => {
      const hasSettings = db.sqlite
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'",
        )
        .get();
      if (
        hasSettings &&
        Number(getSetting(db, 'schema_version') ?? 0) > version
      )
        fail(
          'unavailable',
          'Нельзя применить старый migrator к более новой схеме.',
        );
      db.sqlite.exec(
        'CREATE TABLE IF NOT EXISTS __taskindex_migrations(name TEXT PRIMARY KEY NOT NULL, sha256 TEXT)',
      );
      if (!readJournal(db))
        db.sqlite.exec(
          'ALTER TABLE __taskindex_migrations ADD COLUMN sha256 TEXT',
        );
      const applied = readJournal(db)!;
      // Verify the whole applied chain before touching anything.
      const backfill: JournalRow[] = [];
      for (const row of applied) {
        const file = bundled.find((m) => m.name === row.name);
        if (!file)
          fail(
            'unavailable',
            `В базе есть неизвестная этому образу миграция ${row.name}.`,
          );
        if (row.sha256 === null) backfill.push(row);
        else if (row.sha256 !== file.sha256) changedMigration(row.name);
      }
      // Baseline for journals written before checksums existed: trust the
      // bundled file once and say so in the log.
      for (const row of backfill) {
        db.sqlite
          .prepare('UPDATE __taskindex_migrations SET sha256=? WHERE name=?')
          .run(bundled.find((m) => m.name === row.name)!.sha256, row.name);
        logger.warn({ event: 'migration_checksum_backfilled', name: row.name });
      }
      for (const file of bundled) {
        if (applied.some((row) => row.name === file.name)) continue;
        db.sqlite.exec(readFileSync(resolve(dir, file.name), 'utf8'));
        db.sqlite
          .prepare(
            'INSERT INTO __taskindex_migrations(name, sha256) VALUES(?, ?)',
          )
          .run(file.name, file.sha256);
      }
      if (!getSetting(db, 'generation'))
        setSetting(db, 'generation', randomUUID());
      if (!getSetting(db, 'timezone'))
        setSetting(db, 'timezone', options.timezone ?? 'Europe/Moscow');
      if (getSetting(db, 'schema_version') !== String(version))
        setSetting(db, 'schema_version', String(version));
    })
    .immediate();
}
export const initializeDatabase = migrate;
// The schema matches the image only when the applied chain has exactly the
// bundled names with the bundled checksums; a journal without checksums must
// go through `migrate` first (baseline backfill).
export function assertSchema(db: DatabaseHandle, migrationsDir?: string) {
  const bundled = bundledMigrations(migrationsDirectory(migrationsDir));
  const mismatch = () =>
    fail(
      'unavailable',
      'Схема базы не соответствует образу. Запустите миграции подходящим образом.',
    );
  const applied = readJournal(db) ?? mismatch();
  for (const row of applied) {
    const file = bundled.find((m) => m.name === row.name);
    if (!file || row.sha256 === null) mismatch();
    if (row.sha256 !== file!.sha256) changedMigration(row.name);
  }
  if (
    applied.length !== bundled.length ||
    getSetting(db, 'schema_version') !== String(bundled.length)
  )
    mismatch();
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
