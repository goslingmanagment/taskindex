import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, it, expect } from 'vitest';
import type { DrizzleSQLiteSnapshotJSON } from 'drizzle-kit/api';
import * as schema from '../../src/server/schema.js';
import { z } from '../../src/shared/schemas.js';
import {
  openDatabase,
  migrate,
  assertSchema,
  bundledMigrations,
  migrationsDirectory,
  schemaVersion,
} from '../../src/server/db.js';
import { initialize } from '../../src/server/admin.js';
import { createApp } from '../../src/server/app.js';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
const journalRows = (db: ReturnType<typeof openDatabase>) =>
  db.sqlite
    .prepare('SELECT name, sha256 FROM __taskindex_migrations ORDER BY name')
    .all() as { name: string; sha256: string | null }[];
const totalChanges = (db: ReturnType<typeof openDatabase>) =>
  (db.sqlite.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
const unavailable = expect.objectContaining({ code: 'unavailable' });
const require = createRequire(import.meta.url);
const kit = require('drizzle-kit/api') as typeof import('drizzle-kit/api');
it('tracks the full runtime schema in Drizzle metadata without generating duplicate CREATE TABLE migrations', async () => {
  const journal = JSON.parse(
    readFileSync(resolve('drizzle/v2/meta/_journal.json'), 'utf8'),
  ) as { entries: { idx: number; tag: string }[] };
  const latest = journal.entries.at(-1)!;
  const snapshot = JSON.parse(
    readFileSync(
      resolve(
        `drizzle/v2/meta/${String(latest.idx).padStart(4, '0')}_snapshot.json`,
      ),
      'utf8',
    ),
  ) as DrizzleSQLiteSnapshotJSON;
  const current = await kit.generateSQLiteDrizzleJson(schema, snapshot.id);
  expect(await kit.generateSQLiteMigration(snapshot, current)).toEqual([]);
  const description = z
    .object({
      tables: z.record(
        z.string(),
        z.object({
          name: z.string(),
          columns: z.record(
            z.string(),
            z.object({
              name: z.string(),
              type: z.string(),
              notNull: z.boolean(),
              primaryKey: z.boolean(),
            }),
          ),
          indexes: z.record(
            z.string(),
            z.object({
              name: z.string(),
              isUnique: z.boolean(),
              columns: z.array(z.string()),
            }),
          ),
        }),
      ),
    })
    .parse(snapshot);
  const db = openDatabase(':memory:');
  try {
    migrate(db);
    migrate(db);
    expect(
      db.sqlite
        .prepare('SELECT name FROM __taskindex_migrations ORDER BY name')
        .all(),
    ).toEqual(journal.entries.map((entry) => ({ name: `${entry.tag}.sql` })));
    for (const table of Object.values(description.tables)) {
      const actual = db.sqlite.pragma(`table_info(${table.name})`) as {
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }[];
      expect(
        actual.map((c) => ({
          name: c.name,
          type: c.type.toLowerCase(),
          notNull: Boolean(c.notnull),
          primaryKey: Boolean(c.pk),
        })),
      ).toEqual(
        Object.values(table.columns).map((c) => ({
          name: c.name,
          type: c.type,
          notNull: c.notNull,
          primaryKey: c.primaryKey,
        })),
      );
      const indexes = db.sqlite.pragma(`index_list(${table.name})`) as {
        name: string;
        unique: number;
      }[];
      for (const index of Object.values(table.indexes)) {
        expect(indexes).toContainEqual(
          expect.objectContaining({
            name: index.name,
            unique: Number(index.isUnique),
          }),
        );
        const columns = db.sqlite.pragma(`index_xinfo(${index.name})`) as {
          name: string;
          key: number;
          coll: string;
        }[];
        expect(columns.filter((c) => c.key).map((c) => c.name)).toEqual(
          index.columns,
        );
        if (index.name === 'tasks_order')
          expect(columns.find((c) => c.name === 'order_key')?.coll).toBe(
            'BINARY',
          );
      }
    }
    expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});
it('derives the schema version from the bundled migration chain and rejects journals that differ from the image', async () => {
  const journal = JSON.parse(
    readFileSync(resolve('drizzle/v2/meta/_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[] };
  const dir = migrationsDirectory();
  expect(dir).toBe(resolve('drizzle/v2'));
  expect(schemaVersion()).toBe(journal.entries.length);
  expect(schemaVersion()).toBe(
    readdirSync(dir).filter((n) => n.endsWith('.sql')).length,
  );
  expect(bundledMigrations(dir).map((m) => m.name)).toEqual(
    journal.entries.map((e) => `${e.tag}.sql`),
  );
  const db = openDatabase(':memory:');
  cleanup.push(() => db.close());
  expect(initialize(db).schemaVersion).toBe(schemaVersion());
  const app = createApp({ db });
  cleanup.push(() => app.closeStreams());
  expect(await (await app.request('/health')).json()).toMatchObject({
    ok: true,
    schemaVersion: schemaVersion(),
  });
  expect(() => assertSchema(db)).not.toThrow();
  db.sqlite
    .prepare(
      "INSERT INTO __taskindex_migrations(name, sha256) VALUES('9999_extra.sql', 'x')",
    )
    .run();
  expect(() => assertSchema(db)).toThrow(unavailable);
  expect((await app.request('/health')).status).toBe(503);
  db.sqlite
    .prepare(
      "DELETE FROM __taskindex_migrations WHERE name IN ('9999_extra.sql', '0000_taskindex.sql')",
    )
    .run();
  expect(() => assertSchema(db)).toThrow(unavailable);
});
it('stores checksums of applied SQL, repeats an unchanged chain as a no-op and refuses an edited migration before applying anything', () => {
  const dir = migrationsDirectory();
  const bundled = bundledMigrations(dir);
  const db = openDatabase(':memory:');
  cleanup.push(() => db.close());
  migrate(db);
  expect(journalRows(db)).toEqual(bundled);
  const before = totalChanges(db);
  const warnings: Record<string, unknown>[] = [];
  migrate(db, { logger: { warn: (fields) => warnings.push(fields) } });
  expect(totalChanges(db)).toBe(before);
  expect(warnings).toEqual([]);
  expect(() => assertSchema(db)).not.toThrow();
  // A copy of the image with one edited byte in the applied baseline and one
  // unapplied migration after it.
  const copy = mkdtempSync(join(tmpdir(), 'taskindex-migrations-'));
  cleanup.push(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(dir, copy, { recursive: true });
  writeFileSync(
    join(copy, '0000_taskindex.sql'),
    `${readFileSync(join(copy, '0000_taskindex.sql'), 'utf8')}\n-- edited\n`,
  );
  writeFileSync(
    join(copy, '9999_probe.sql'),
    'CREATE TABLE `probe` (`id` text PRIMARY KEY NOT NULL);\n',
  );
  const edited = /Содержимое применённой миграции 0000_taskindex\.sql изменено/;
  expect(() => migrate(db, { migrationsDir: copy })).toThrow(edited);
  expect(() => migrate(db, { migrationsDir: copy })).toThrow(unavailable);
  expect(totalChanges(db)).toBe(before);
  expect(journalRows(db)).toEqual(bundled);
  expect(
    db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE name='probe'")
      .get(),
  ).toBeUndefined();
  expect(() => assertSchema(db, copy)).toThrow(edited);
  // CRLF checkouts hash the same as LF.
  const crlf = mkdtempSync(join(tmpdir(), 'taskindex-migrations-crlf-'));
  cleanup.push(() => rmSync(crlf, { recursive: true, force: true }));
  for (const m of bundled)
    writeFileSync(
      join(crlf, m.name),
      readFileSync(join(dir, m.name), 'utf8').replace(/\n/g, '\r\n'),
    );
  expect(bundledMigrations(crlf)).toEqual(bundled);
  expect(() => assertSchema(db, crlf)).not.toThrow();
});
it('backfills checksums for a journal written before they existed and warns once per migration', () => {
  const dir = migrationsDirectory();
  const bundled = bundledMigrations(dir);
  const legacy = openDatabase(':memory:');
  cleanup.push(() => legacy.close());
  legacy.sqlite.exec(
    'CREATE TABLE __taskindex_migrations(name TEXT PRIMARY KEY NOT NULL)',
  );
  legacy.sqlite.exec(readFileSync(join(dir, '0000_taskindex.sql'), 'utf8'));
  legacy.sqlite
    .prepare('INSERT INTO __taskindex_migrations(name) VALUES(?)')
    .run('0000_taskindex.sql');
  legacy.sqlite.exec(
    "INSERT INTO settings(key, value) VALUES ('generation', 'legacy'), ('timezone', 'Europe/Moscow'), ('schema_version', '1')",
  );
  expect(() => assertSchema(legacy)).toThrow(unavailable);
  const warnings: Record<string, unknown>[] = [];
  migrate(legacy, { logger: { warn: (fields) => warnings.push(fields) } });
  expect(warnings).toEqual([
    { event: 'migration_checksum_backfilled', name: '0000_taskindex.sql' },
  ]);
  expect(journalRows(legacy)).toEqual(bundled);
  expect(() => assertSchema(legacy)).not.toThrow();
  migrate(legacy, { logger: { warn: (fields) => warnings.push(fields) } });
  expect(warnings).toHaveLength(1);
});
