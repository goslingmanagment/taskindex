// TI-014: a database and an export of the previous schema version go through
// migrate → export → validateExport → import → operation get → envelope repeat.
// The fixture tests/fixtures/export-schema-2.json was produced on the code of
// schema version 2 (format 1) by export-schema-2.seed.mts; when a new schema
// version becomes the previous one, regenerate it there and rename both.
// 2026-09-10: schema version 4 (0003_appearance) keeps this fixture instead of
// a version-3 one: an older export exercises a strictly longer upgrade chain
// (format 1 -> operationSeq -> appearance) than the immediately previous one.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import type { z } from 'zod';
import {
  openDatabase,
  migrate,
  assertSchema,
  getSetting,
  setSetting,
  migrationsDirectory,
  schemaVersion,
  readOperations,
  latestOperationSeq,
  writeState,
} from '../../src/server/db.js';
import {
  exportWorkspace,
  importWorkspace,
  listAgents,
  validateExport,
} from '../../src/server/admin.js';
import { createApp } from '../../src/server/app.js';
import {
  defaultAppearance,
  exportSchemaV1,
} from '../../src/shared/domain-schemas.js';
import { FORMAT_VERSION } from '../../src/shared/model.js';
import { owner } from './helpers.js';
type LegacyExport = z.infer<typeof exportSchemaV1>;
const FIXTURE_SCHEMA_VERSION = 2;
const raw = JSON.parse(
  readFileSync(
    new URL('../fixtures/export-schema-2.json', import.meta.url),
    'utf8',
  ),
) as Record<string, unknown>;
const fixture = exportSchemaV1.parse(raw);
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
// The migrations of the previous version only.
function legacyMigrations() {
  const dir = mkdtempSync(join(tmpdir(), 'taskindex-legacy-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['0000_taskindex.sql', '0001_agent_keys.sql'])
    cpSync(join(migrationsDirectory(), name), join(dir, name));
  expect(schemaVersion(dir)).toBe(FIXTURE_SCHEMA_VERSION);
  return dir;
}
// What `taskindex-admin import` of that version wrote: the same tables minus
// operations.operation_seq, so the rows go in through SQL of that shape.
function loadLegacy(db: ReturnType<typeof openDatabase>, data: LegacyExport) {
  db.sqlite.transaction(() => {
    for (const [key, value] of Object.entries(data.settings))
      if (key !== 'approved_deployment') setSetting(db, key, value);
    writeState(db, {
      projects: data.projects,
      tasks: data.tasks,
      comments: data.comments,
      appearance: [],
    });
    const agent = db.sqlite.prepare(
      'INSERT INTO agents(id, label, created_at, disabled_at) VALUES (?, ?, ?, ?)',
    );
    for (const a of data.agents)
      agent.run(a.id, a.label, a.createdAt, a.disabledAt);
    const event = db.sqlite.prepare(
      'INSERT INTO events(seq, at, actor_id, actor_label, operation_id, entity_kind, entity_id, task_id, command, changes, record_revision, first_seq, last_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const e of data.events)
      event.run(
        e.seq,
        e.at,
        e.actorId,
        e.actorLabel,
        e.operationId,
        e.entityKind,
        e.entityId,
        e.taskId ?? null,
        e.command,
        JSON.stringify(e.changes),
        e.recordRevision,
        e.firstSeq,
        e.lastSeq,
      );
    const operation = db.sqlite.prepare(
      'INSERT INTO operations(id, actor_id, actor_label, command, command_hash, status, result, first_seq, last_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const o of data.operations)
      operation.run(
        o.id,
        o.actorId,
        o.actorLabel,
        o.command,
        o.commandHash,
        o.status,
        JSON.stringify(o.result),
        o.firstSeq,
        o.lastSeq,
        o.createdAt,
      );
    db.sqlite.prepare("DELETE FROM sqlite_sequence WHERE name='events'").run();
    db.sqlite
      .prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('events', ?)")
      .run(data.seq);
  })();
}
// Operations of the fixture in (createdAt, id) order: the backfill rule.
const expectedPositions = [...fixture.operations]
  .sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
  .map((o, index): [string, number] => [o.id, index + 1]);
describe('migration compatibility of the previous schema version (TI-014)', () => {
  it('the fixture covers tables, events, results and clients of that version', () => {
    expect(fixture.formatVersion).toBe(1);
    expect(fixture.settings.schema_version).toBe(
      String(FIXTURE_SCHEMA_VERSION),
    );
    expect(fixture.agents.map((a) => a.id)).toEqual(['test-agent']);
    expect(fixture.projects).toHaveLength(1);
    expect(fixture.tasks).toHaveLength(2);
    expect(fixture.comments).toHaveLength(2);
    expect(fixture.events).toHaveLength(10);
    const commands = new Set(fixture.operations.map((o) => o.command));
    for (const command of [
      'task.create',
      'project.create',
      'task.update',
      'comment.add',
      'checklist.add',
      'task.sync',
      'batch',
      'undo',
    ])
      expect(commands.has(command as never), command).toBe(true);
    expect(
      fixture.operations.filter((o) => !o.ok).map((o) => o.errorCode),
    ).toEqual(['conflict']);
    expect(
      fixture.operations.filter((o) => o.ok && o.firstSeq === null).length,
    ).toBeGreaterThanOrEqual(2);
  });
  it('a database of the previous version migrates, exports as format 2, validates, imports and answers every stored operation', async () => {
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db, { migrationsDir: legacyMigrations() });
    expect(getSetting(db, 'schema_version')).toBe(
      String(FIXTURE_SCHEMA_VERSION),
    );
    loadLegacy(db, fixture);
    expect(() => assertSchema(db)).toThrow();
    migrate(db, { logger: { warn: () => {} } });
    expect(() => assertSchema(db)).not.toThrow();
    expect(getSetting(db, 'schema_version')).toBe(String(schemaVersion()));
    const migrated = readOperations(db);
    expect(migrated.map((o) => [o.id, o.operationSeq])).toEqual(
      expectedPositions,
    );
    expect(
      migrated.map(({ operationSeq: _seq, titles: _titles, ...rest }) => rest),
    ).toEqual(
      expectedPositions.map(([id]) => {
        const { titles: _titles, ...op } = fixture.operations.find(
          (o) => o.id === id,
        )!;
        return op;
      }),
    );
    const exported = exportWorkspace(db);
    expect(exported.formatVersion).toBe(FORMAT_VERSION);
    expect(exported.appearance).toEqual([defaultAppearance()]);
    expect(exported.seq).toBe(fixture.seq);
    expect(() => validateExport(exported)).not.toThrow();
    const target = openDatabase(':memory:');
    cleanup.push(() => target.close());
    migrate(target);
    importWorkspace(target, exported);
    expect(listAgents(target)).toEqual(fixture.agents);
    const app = createApp({ db: target, authorize: () => owner });
    cleanup.push(() => app.closeStreams());
    const positions = new Map(expectedPositions);
    for (const op of fixture.operations) {
      const response = await app.request(`/api/operations/${op.id}`);
      expect(response.status, op.id).toBe(200);
      const body = (await response.json()) as {
        operationSeq: number;
        result: unknown;
        status: number;
      };
      expect(body.result, op.id).toEqual(op.result);
      expect(body.status).toBe(op.status);
      expect(body.operationSeq).toBe(positions.get(op.id));
    }
    // The old envelope of the first operation gets its stored outcome on the
    // migrated database and takes no new journal position.
    const live = createApp({ db, authorize: () => owner });
    cleanup.push(() => live.closeStreams());
    const before = latestOperationSeq(db);
    const repeat = await live.request('/api/commands', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({
        command: 'task.create',
        payload: {
          id: 't1',
          area: 'agency',
          title: 'Задача',
          checklist: [{ id: 's1', text: 'Первый шаг', done: false }],
        },
        operationId: 'op-01-create',
        generation: fixture.generation,
        dryRun: false,
      }),
    });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual(
      fixture.operations.find((o) => o.id === 'op-01-create')!.result,
    );
    expect(latestOperationSeq(db)).toBe(before);
  });
  it('an export of format 1 imports into the current schema with the same positions', () => {
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db);
    importWorkspace(db, raw);
    expect(readOperations(db).map((o) => [o.id, o.operationSeq])).toEqual(
      expectedPositions,
    );
    expect(getSetting(db, 'schema_version')).toBe(String(schemaVersion()));
    const exported = exportWorkspace(db);
    expect(exported.formatVersion).toBe(FORMAT_VERSION);
    expect(() => validateExport(exported)).not.toThrow();
    expect(exported.tasks).toEqual(fixture.tasks);
    expect(exported.events).toHaveLength(fixture.events.length);
  });
  it('refuses an export of a newer schema version and a broken journal', () => {
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db);
    expect(() =>
      importWorkspace(db, {
        ...raw,
        settings: { ...fixture.settings, schema_version: '99' },
      }),
    ).toThrow(/не поддерживается/);
    importWorkspace(db, raw);
    const current = exportWorkspace(db);
    expect(() => validateExport(current)).not.toThrow();
    const shifted = {
      ...current,
      operations: current.operations.map((o) => ({
        ...o,
        operationSeq: o.operationSeq + 1,
      })),
    };
    expect(() => validateExport(shifted)).toThrow(/позиции операций/);
  });
});
