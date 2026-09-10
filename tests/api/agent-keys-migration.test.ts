import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import {
  openDatabase,
  migrate,
  assertSchema,
  bundledMigrations,
  migrationsDirectory,
  getSetting,
} from '../../src/server/db.js';
import {
  hashAgentKey,
  verifyAgentKey,
  listAgentKeys,
} from '../../src/server/agent-keys.js';
// SHA-256('abc') as base64url without padding, verified against the former
// plugin's defaultKeyHasher (@better-auth/api-key 1.7.3) on 2026-09-10.
const VECTOR = 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0';
it('moves plugin-issued keys into agent_keys with the same hash and timestamps, drops the apikey table and unbound keys', () => {
  expect(hashAgentKey('abc')).toBe(VECTOR);
  const dir = migrationsDirectory();
  const baseline = bundledMigrations(dir)[0]!;
  expect(baseline.name).toBe('0000_taskindex.sql');
  const db = openDatabase(':memory:');
  try {
    // A database exactly as the first release left it: baseline only.
    db.sqlite.exec(
      'CREATE TABLE __taskindex_migrations(name TEXT PRIMARY KEY NOT NULL, sha256 TEXT)',
    );
    db.sqlite.exec(readFileSync(join(dir, baseline.name), 'utf8'));
    db.sqlite
      .prepare('INSERT INTO __taskindex_migrations(name, sha256) VALUES(?, ?)')
      .run(baseline.name, baseline.sha256);
    db.sqlite.exec(
      "INSERT INTO settings(key, value) VALUES ('generation', 'g'), ('timezone', 'Europe/Moscow'), ('schema_version', '1')",
    );
    db.sqlite
      .prepare(
        "INSERT INTO agents(id, label, created_at) VALUES ('a1', 'Agent', ?)",
      )
      .run('2026-09-01T00:00:00.000Z');
    const insert = db.sqlite.prepare(
      'INSERT INTO apikey(id, reference_id, key, enabled, agent_id, scope, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const created = 1788875004514;
    insert.run(
      'k1',
      'owner',
      VECTOR,
      1,
      'a1',
      'tasks',
      'first',
      created,
      created,
    );
    insert.run(
      'k2',
      'owner',
      'other-hash',
      0,
      'a1',
      'read',
      null,
      created,
      created,
    );
    insert.run(
      'k3',
      'owner',
      'orphan-hash',
      1,
      null,
      null,
      'orphan',
      created,
      created,
    );
    migrate(db, { logger: { warn: () => {} } });
    expect(
      db.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('apikey', 'agent_keys') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: 'agent_keys' }]);
    expect(getSetting(db, 'schema_version')).toBe('2');
    expect(() => assertSchema(db)).not.toThrow();
    const keys = listAgentKeys(db);
    expect(keys).toHaveLength(2);
    expect(keys.find((k) => k.id === 'k1')).toEqual({
      id: 'k1',
      agentId: 'a1',
      scope: 'tasks',
      name: 'first',
      createdAt: new Date(created).toISOString(),
      revokedAt: null,
    });
    expect(keys.find((k) => k.id === 'k2')).toMatchObject({
      scope: 'read',
      revokedAt: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      ),
    });
    expect(verifyAgentKey(db, 'abc')).toMatchObject({
      actor: { id: 'agent:a1', agentId: 'a1', kind: 'agent', scope: 'tasks' },
      credential: { kind: 'agent-key', keyId: 'k1', agentId: 'a1' },
    });
    expect(() => verifyAgentKey(db, 'abd')).toThrow(
      expect.objectContaining({ code: 'forbidden' }),
    );
    expect(
      db.sqlite.prepare('SELECT key_hash FROM agent_keys WHERE id=?').get('k1'),
    ).toEqual({ key_hash: VECTOR });
  } finally {
    db.close();
  }
});
