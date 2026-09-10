import SQLite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema.js';
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
  // The path travels with the handle: the generation sidecar (Ж13) lives next
  // to the file, and `:memory:` says at once that there is no file.
  return { path, sqlite, orm, close: () => sqlite.close() };
}
export type DatabaseHandle = ReturnType<typeof openDatabase>;
// The two transaction shapes of the server (plan 06, step 6). A write takes
// the write lock at once (`immediate`), so two writers never collide halfway
// through; a read stays deferred and does not wait for a writer.
export const withWrite = <T>(db: DatabaseHandle, fn: () => T): T =>
  db.sqlite.transaction(fn).immediate();
export const withRead = <T>(db: DatabaseHandle, fn: () => T): T =>
  db.sqlite.transaction(fn)();
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
// Position of the last stored operation in the journal (0 when empty).
export function latestOperationSeq(db: DatabaseHandle): number {
  return (
    db.sqlite
      .prepare('SELECT COALESCE(MAX(operation_seq),0) AS n FROM operations')
      .get() as { n: number }
  ).n;
}
export type SidecarLogger = { warn: (fields: Record<string, unknown>) => void };
export const generationSidecarPath = (path: string) => `${path}.generation`;
// Ж13, stage 1: the generation of the database mirrored in a file next to it.
// Written through a temporary file and a rename, so a crash never leaves half
// a value. In-memory databases have no file and are skipped.
export function writeGenerationSidecar(db: DatabaseHandle) {
  const current = getSetting(db, 'generation');
  if (db.path === ':memory:' || !current) return;
  const target = generationSidecarPath(db.path);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, current);
  renameSync(temporary, target);
}
// A database file swapped in without `taskindex-admin mark-restored` keeps the
// old generation in settings while the sidecar of the copy names another one.
// Stage 1 says so in the log; stage 2 (after one drill) refuses to start.
export function checkGenerationSidecar(
  db: DatabaseHandle,
  logger: SidecarLogger,
) {
  const current = getSetting(db, 'generation');
  if (db.path === ':memory:' || !current) return;
  const target = generationSidecarPath(db.path);
  if (!existsSync(target)) return;
  const sidecar = readFileSync(target, 'utf8').trim();
  if (sidecar !== current)
    logger.warn({
      event: 'generation_sidecar_mismatch',
      sidecar,
      generation: current,
      path: target,
    });
}
