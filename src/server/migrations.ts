import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseHandle } from './sqlite.js';
import {
  getSetting,
  setSetting,
  withWrite,
  writeGenerationSidecar,
} from './sqlite.js';
import { fail } from '../shared/errors.js';

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
  withWrite(db, () => {
    const hasSettings = db.sqlite
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'",
      )
      .get();
    if (hasSettings && Number(getSetting(db, 'schema_version') ?? 0) > version)
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
  });
  writeGenerationSidecar(db);
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
