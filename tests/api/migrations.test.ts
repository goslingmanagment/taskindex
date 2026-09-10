import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { it, expect } from 'vitest';
import type { DrizzleSQLiteSnapshotJSON } from 'drizzle-kit/api';
import * as schema from '../../src/server/schema.js';
import { z } from '../../src/shared/schemas.js';
import { openDatabase, migrate } from '../../src/server/db.js';
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
