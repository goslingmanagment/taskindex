// TI-014: a database and an export of the previous schema version go through
// migrate → export → validateExport → import → operation get → envelope repeat.
// The fixture tests/fixtures/export-schema-2.json was produced on the code of
// schema version 2 (format 1) by export-schema-2.seed.mts; when a new schema
// version becomes the previous one, regenerate it there and rename both.
// 2026-09-10: schema version 4 (0003_appearance) keeps this fixture instead of
// a version-3 one: an older export exercises a strictly longer upgrade chain
// (format 1 -> operationSeq -> appearance) than the immediately previous one.
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
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
  readState,
  latestOperationSeq,
  writeState,
} from '../../src/server/db.js';
import {
  exportWorkspace,
  importWorkspace,
  listAgents,
  upgradeExport,
  validateExport,
} from '../../src/server/admin.js';
import { createApp } from '../../src/server/app.js';
import {
  defaultAppearance,
  exportSchemaV1,
  exportSchemaV4,
  exportSchemaV5,
  exportSchemaV6,
  exportSchemaV7,
  exportSchemaV8,
  operationResponseSchema,
  storedOperationSchema,
} from '../../src/shared/domain-schemas.js';
import { FORMAT_VERSION } from '../../src/shared/model.js';
import { SEEDED_LABELS } from '../../src/shared/labels.js';
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
// operations.operation_seq and tasks.focus_key/focus_left_at, so the rows go
// in through SQL of that shape.
function loadLegacy(db: ReturnType<typeof openDatabase>, data: LegacyExport) {
  db.sqlite.transaction(() => {
    for (const [key, value] of Object.entries(data.settings))
      if (key !== 'approved_deployment') setSetting(db, key, value);
    writeState(db, {
      projects: data.projects,
      labels: [],
      tasks: [],
      steps: [],
      comments: [],
      proposals: [],
      appearance: [],
    });
    const task = db.sqlite.prepare(
      'INSERT INTO tasks(id, area, project_id, title, status, note, due, waiting_for, follow_up, order_key, focus, archived, origin_system, origin_ref, origin_url, origin_version, created_by, created_by_label, owner_touched_at, owner_fields, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const step = db.sqlite.prepare(
      'INSERT INTO checklist_items(id, task_id, text, done, position) VALUES (?, ?, ?, ?, ?)',
    );
    for (const t of data.tasks) {
      task.run(
        t.id,
        t.area,
        t.projectId,
        t.title,
        t.status,
        t.note,
        t.due,
        t.waitingFor,
        t.followUp,
        t.orderKey,
        Number(t.focus),
        Number(t.archived),
        t.originSystem,
        t.originRef,
        t.originUrl,
        t.originVersion,
        t.createdBy,
        t.createdByLabel,
        t.ownerTouchedAt,
        JSON.stringify(t.ownerFields),
        t.revision,
        t.createdAt,
        t.updatedAt,
      );
      for (const [position, item] of t.checklist.entries())
        step.run(item.id, t.id, item.text, Number(item.done), position);
    }
    writeState(db, {
      projects: [],
      labels: [],
      tasks: [],
      steps: [],
      comments: data.comments,
      proposals: [],
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
    // Format 4 adds the desk fields: none of the fixture tasks is focused.
    // Format 4 adds the desk fields, 0008 takes the owner's `checklist`
    // entry off the task: none of the fixture tasks is focused.
    expect(exported.tasks).toEqual(
      fixture.tasks.map((t) => ({
        ...t,
        focusKey: null,
        focusLeftAt: null,
        ownerFields: t.ownerFields.filter((field) => field !== 'checklist'),
      })),
    );
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
// Plan 13, step 1: 0004_focus_desk adds focus_key and focus_left_at. Tasks
// already in focus get keys in (area, status, order_key, id) order, so the
// desk starts in board order; an export of the previous format gets the same
// keys from upgradeExport (data migration rule, variant (b)).
describe('0004_focus_desk backfill', () => {
  const rows = [
    ['b', 'personal', 'todo', 'a1', 1],
    ['a', 'agency', 'todo', 'a2', 1],
    ['c', 'agency', 'todo', 'a1', 1],
    ['d', 'agency', 'doing', 'a0', 1],
    ['e', 'agency', 'todo', 'a0', 0],
  ] as const;
  const expectedOrder = ['d', 'c', 'a', 'b'];
  it('assigns unique focus keys to focused tasks in board order and none to the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'taskindex-v4-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const name of [
      '0000_taskindex.sql',
      '0001_agent_keys.sql',
      '0002_operation_seq.sql',
      '0003_appearance.sql',
    ])
      cpSync(join(migrationsDirectory(), name), join(dir, name));
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db, { migrationsDir: dir });
    const insert = db.sqlite.prepare(
      "INSERT INTO tasks(id, area, project_id, title, status, note, due, waiting_for, follow_up, order_key, focus, archived, origin_system, origin_ref, origin_url, origin_version, created_by, created_by_label, owner_touched_at, owner_fields, revision, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, '', NULL, '', NULL, ?, ?, 0, NULL, NULL, NULL, NULL, 'owner', 'Владелец', NULL, '[]', 1, '2026-09-08T12:00:00.000Z', '2026-09-08T12:00:00.000Z')",
    );
    for (const [id, area, status, orderKey, focus] of rows)
      insert.run(id, area, id, status, orderKey, focus);
    migrate(db, { logger: { warn: () => {} } });
    expect(() => assertSchema(db)).not.toThrow();
    const focused = db.sqlite
      .prepare(
        'SELECT id, focus_key AS key, focus_left_at AS left FROM tasks WHERE focus_key IS NOT NULL ORDER BY focus_key',
      )
      .all() as { id: string; key: string; left: string | null }[];
    expect(focused.map((t) => t.id)).toEqual(expectedOrder);
    expect(new Set(focused.map((t) => t.key)).size).toBe(4);
    expect(focused.every((t) => t.left === null)).toBe(true);
    expect(
      db.sqlite.prepare("SELECT focus_key FROM tasks WHERE id = 'e'").get(),
    ).toEqual({ focus_key: null });
    // Every key is a valid fractional-indexing key: a new task can be placed
    // around any of them.
    const state = readState(db);
    for (const t of state.tasks) expect(t.focus).toBe(t.focusKey !== null);
    expect(
      () =>
        db.sqlite
          .prepare("UPDATE tasks SET focus_key = ? WHERE id = 'e'")
          .run(focused[0]!.key),
      'partial unique index',
    ).toThrow(/UNIQUE/);
  });
  it('upgradeExport of a format 3 export assigns the same keys', () => {
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db);
    const exported = exportWorkspace(db);
    const legacyTasks = rows.map(([id, area, status, orderKey, focus]) => ({
      id,
      area,
      projectId: null,
      title: id,
      status,
      note: '',
      due: null,
      waitingFor: '',
      followUp: null,
      orderKey,
      focus: focus === 1,
      archived: false,
      checklist: [],
      commentCount: 0,
      originSystem: null,
      originRef: null,
      originUrl: null,
      originVersion: null,
      createdBy: 'owner',
      createdByLabel: 'Владелец',
      ownerTouchedAt: null,
      ownerFields: [],
      revision: 1,
      createdAt: '2026-09-08T12:00:00.000Z',
      updatedAt: '2026-09-08T12:00:00.000Z',
    }));
    const {
      labels: _labels,
      steps: _steps,
      proposals: _proposals,
      ...withoutCatalogue
    } = exported;
    const upgraded = upgradeExport({
      ...withoutCatalogue,
      checklistItems: [],
      formatVersion: 3,
      tasks: legacyTasks,
    });
    expect(upgraded.formatVersion).toBe(FORMAT_VERSION);
    const keyed = upgraded.tasks
      .filter((t) => t.focusKey !== null)
      .sort((a, b) => (a.focusKey! < b.focusKey! ? -1 : 1));
    expect(keyed.map((t) => t.id)).toEqual(expectedOrder);
    expect(upgraded.tasks.every((t) => t.focusLeftAt === null)).toBe(true);
    expect(upgraded.tasks.find((t) => t.id === 'e')!.focusKey).toBeNull();
  });
});

const postMigrationCommand = (
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown>,
) =>
  app.request('/api/commands', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:5173',
    },
    body: JSON.stringify(body),
  });

// Rows of a previous-version export go in through SQL of the old physical
// schema: it chooses the columns, and current Drizzle codecs already name
// columns that schema lacks.
type PreviousRows = {
  settings: Record<string, string>;
  projects: unknown[];
  tasks: unknown[];
  // Step rows before 0008, step records after it.
  checklistItems?: unknown[];
  steps?: unknown[];
  comments: unknown[];
  agents: unknown[];
  events: unknown[];
  operations: unknown[];
  appearance: unknown[];
};
function loadRows(db: ReturnType<typeof openDatabase>, previous: PreviousRows) {
  const tables = {
    settings: Object.entries(previous.settings).map(([key, value]) => ({
      key,
      value,
    })),
    projects: previous.projects,
    tasks: previous.tasks,
    checklist_items: previous.checklistItems ?? previous.steps ?? [],
    comments: previous.comments,
    agents: previous.agents,
    events: previous.events,
    operations: previous.operations,
    appearance: previous.appearance,
  };
  db.sqlite.transaction(() => {
    for (const [table, rows] of Object.entries(tables)) {
      if (!rows.length) continue;
      const columns = (
        db.sqlite.pragma(`table_info(${table})`) as { name: string }[]
      ).map(({ name }) => name);
      const insert = db.sqlite.prepare(
        `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      );
      for (const row of rows) {
        const values = row as Record<string, unknown>;
        insert.run(
          ...columns.map((column) => {
            const key = column.replace(/_([a-z])/g, (_, letter: string) =>
              letter.toUpperCase(),
            );
            const value = values[key];
            if (value == null) return null;
            if (typeof value === 'boolean') return Number(value);
            return typeof value === 'object' ? JSON.stringify(value) : value;
          }),
        );
      }
    }
  })();
}
function appFor(db: ReturnType<typeof openDatabase>) {
  const app = createApp({
    db,
    baseURL: 'http://localhost:3001',
    trustedOrigins: ['http://localhost:5173'],
    authorize: () => owner,
  });
  cleanup.push(() => app.closeStreams());
  return app;
}
describe('0005_priority_labels_closes backfill', () => {
  // Generated by the unchanged 0901fd2 checkout, not a new export with fields
  // stripped. Old task/appearance events and success/error records stay intact.
  const previousRaw: unknown = JSON.parse(
    readFileSync(
      new URL('../fixtures/export-schema-5.json', import.meta.url),
      'utf8',
    ),
  );
  const previous = previousRaw as z.input<typeof exportSchemaV4>;
  const defaults = { priority: 'p2', labels: [], closes: null };
  const oldMigrations = () => {
    const dir = mkdtempSync(join(tmpdir(), 'taskindex-schema-5-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const name of [
      '0000_taskindex.sql',
      '0001_agent_keys.sql',
      '0002_operation_seq.sql',
      '0003_appearance.sql',
      '0004_focus_desk.sql',
    ])
      cpSync(join(migrationsDirectory(), name), join(dir, name));
    return dir;
  };
  const loadPrevious = (db: ReturnType<typeof openDatabase>) =>
    loadRows(db, previous);
  it('uses a real format-4 fixture with old task and appearance events, successes and a stored conflict', () => {
    expect(previous.formatVersion).toBe(4);
    expect(previous.settings.schema_version).toBe('5');
    for (const field of ['priority', 'labels', 'closes', 'hideP3'])
      expect(JSON.stringify(previousRaw)).not.toContain(`"${field}"`);
    expect(previous.tasks[0]).toMatchObject({ id: 'old-task', focus: true });
    expect(previous.events.map((event) => event.command)).toEqual([
      'task.create',
      'task.update',
      'appearance.update',
    ]);
    expect(
      previous.operations.find((op) => op.id === 'old-rejected')!.result,
    ).toMatchObject({
      ok: false,
      code: 'conflict',
      current: { id: 'old-task' },
    });
  });

  it('gives existing rows p2, no labels, no problem and a visible P3, and reads them back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'taskindex-v5-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const name of [
      '0000_taskindex.sql',
      '0001_agent_keys.sql',
      '0002_operation_seq.sql',
      '0003_appearance.sql',
      '0004_focus_desk.sql',
    ])
      cpSync(join(migrationsDirectory(), name), join(dir, name));
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db, { migrationsDir: dir });
    db.sqlite
      .prepare(
        "INSERT INTO tasks(id, area, project_id, title, status, note, due, waiting_for, follow_up, order_key, focus, focus_key, focus_left_at, archived, origin_system, origin_ref, origin_url, origin_version, created_by, created_by_label, owner_touched_at, owner_fields, revision, created_at, updated_at) VALUES ('old', 'agency', NULL, 'Old', 'todo', '', NULL, '', NULL, 'a0', 0, NULL, NULL, 0, NULL, NULL, NULL, NULL, 'owner', 'Владелец', NULL, '[]', 1, '2026-09-08T12:00:00.000Z', '2026-09-08T12:00:00.000Z')",
      )
      .run();
    db.sqlite
      .prepare(
        "INSERT INTO appearance(id, mode, skin_id, revision, updated_at) VALUES ('owner', 'dark', 'focus', 2, '2026-09-08T12:00:00.000Z')",
      )
      .run();
    migrate(db, { logger: { warn: () => {} } });
    expect(() => assertSchema(db)).not.toThrow();
    expect(
      db.sqlite
        .prepare("SELECT priority, labels, closes FROM tasks WHERE id = 'old'")
        .get(),
    ).toEqual({ priority: 'p2', labels: '[]', closes: null });
    expect(
      db.sqlite
        .prepare("SELECT hide_p3 FROM appearance WHERE id = 'owner'")
        .get(),
    ).toEqual({ hide_p3: 0 });
    const state = readState(db);
    expect(state.tasks[0]).toMatchObject({
      priority: 'p2',
      labels: [],
      closes: null,
    });
    expect(state.appearance[0]).toMatchObject({ mode: 'dark', hideP3: false });
  });
  it('migrates real schema-5 rows, replays old appearance changes and preserves stored operation outcomes', async () => {
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db, { migrationsDir: oldMigrations() });
    loadPrevious(db);
    migrate(db, { logger: { warn: () => {} } });
    expect(readState(db).tasks[0]).toMatchObject(defaults);
    expect(readState(db).appearance[0]).toMatchObject({
      mode: 'dark',
      skinId: 'focus',
      hideP3: false,
    });
    expect(() => validateExport(exportWorkspace(db))).not.toThrow();
    const app = appFor(db);
    for (const [id, command, payload, status] of [
      [
        'old-appearance',
        'appearance.update',
        { baseRevision: 1, mode: 'dark', skinId: 'focus' },
        200,
      ],
      [
        'old-rejected',
        'task.update',
        { id: 'old-task', baseRevision: 1, note: 'Конфликтующая заметка' },
        409,
      ],
    ] as const) {
      const stored = await app.request(`/api/operations/${id}`);
      expect(stored.status).toBe(200);
      const parsed = storedOperationSchema.parse(await stored.json());
      expect(parsed.status).toBe(status);
      if (parsed.result.ok)
        expect(parsed.result.results[0]!.record).toMatchObject({
          hideP3: false,
        });
      else expect(parsed.result.current).toMatchObject(defaults);
      const repeated = await postMigrationCommand(app, {
        operationId: id,
        generation: getSetting(db, 'generation'),
        command,
        payload,
        dryRun: false,
      });
      expect(repeated.status).toBe(status);
      expect(operationResponseSchema.parse(await repeated.json())).toEqual(
        parsed.result,
      );
    }
    expect(exportWorkspace(db).operations).toHaveLength(
      previous.operations.length,
    );

    const taskUpdate = await postMigrationCommand(app, {
      operationId: 'ti-086-after-migration',
      generation: getSetting(db, 'generation'),
      command: 'task.update',
      payload: {
        id: 'old-task',
        baseRevision: 2,
        priority: 'p1',
        labels: ['dengi'],
        closes: 'old-problem',
      },
    });
    expect(taskUpdate.status).toBe(200);
    const appearanceUpdate = await postMigrationCommand(app, {
      operationId: 'ti-086-hide-after-migration',
      generation: getSetting(db, 'generation'),
      command: 'appearance.update',
      payload: { baseRevision: 2, hideP3: true },
    });
    expect(appearanceUpdate.status).toBe(200);
    const exported = exportWorkspace(db);
    expect(
      exported.events.find((e) => e.operationId === 'ti-086-after-migration')!
        .changes,
    ).toMatchObject({
      priority: { from: 'p2', to: 'p1' },
      labels: { from: [], to: ['dengi'] },
      closes: { from: null, to: 'old-problem' },
    });
    expect(
      exported.events.find(
        (e) => e.operationId === 'ti-086-hide-after-migration',
      )!.changes,
    ).toMatchObject({ hideP3: { from: false, to: true } });
    expect(() => validateExport(exported)).not.toThrow();
    const target = openDatabase(':memory:');
    cleanup.push(() => target.close());
    migrate(target);
    importWorkspace(target, exported);
    expect(readState(target)).toEqual(readState(db));
  });

  it('upgrades and imports a real format-4 export without rewriting its old journal', async () => {
    const upgraded = upgradeExport(previousRaw);
    expect(upgraded.formatVersion).toBe(FORMAT_VERSION);
    expect(upgraded.tasks[0]).toMatchObject(defaults);
    expect(upgraded.appearance[0]).toMatchObject({
      mode: 'dark',
      skinId: 'focus',
      hideP3: false,
    });
    expect(upgraded.events).toEqual(previous.events);
    expect(() => validateExport(upgraded)).not.toThrow();
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db);
    importWorkspace(db, previous);
    expect(readState(db).tasks[0]).toEqual(upgraded.tasks[0]);
    expect(readState(db).appearance).toEqual(upgraded.appearance);
    const app = appFor(db);
    for (const old of upgraded.operations) {
      const response = await app.request(`/api/operations/${old.id}`);
      expect(response.status).toBe(200);
      expect(storedOperationSchema.parse(await response.json()).result).toEqual(
        old.result,
      );
    }
    expect(() => validateExport(exportWorkspace(db))).not.toThrow();
  });
});

describe('0006_drop_otvet_label', () => {
  // Generated by the unchanged dc37568 checkout (schema 6, format 5): task
  // rows, journal changes and stored results all carry the retired label.
  const previousRaw: unknown = JSON.parse(
    readFileSync(
      new URL('../fixtures/export-schema-6.json', import.meta.url),
      'utf8',
    ),
  );
  const previous = previousRaw as z.input<typeof exportSchemaV5>;
  const byId = <T extends { id: string }>(rows: T[]) =>
    rows.toSorted((a, b) => a.id.localeCompare(b.id));
  const oldMigrations = () => {
    const dir = mkdtempSync(join(tmpdir(), 'taskindex-schema-6-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const name of [
      '0000_taskindex.sql',
      '0001_agent_keys.sql',
      '0002_operation_seq.sql',
      '0003_appearance.sql',
      '0004_focus_desk.sql',
      '0005_priority_labels_closes.sql',
    ])
      cpSync(join(migrationsDirectory(), name), join(dir, name));
    return dir;
  };
  const labelsOf = (db: ReturnType<typeof openDatabase>) =>
    Object.fromEntries(
      (
        db.sqlite
          .prepare('SELECT id, labels, revision FROM tasks ORDER BY id')
          .all() as { id: string; labels: string; revision: number }[]
      ).map((row) => [row.id, [row.labels, row.revision]]),
    );
  it('uses a real format-5 fixture whose rows, journal and stored results carry the retired label', () => {
    expect(previous.formatVersion).toBe(5);
    expect(previous.settings.schema_version).toBe('6');
    expect(byId(previous.tasks).map((task) => [task.id, task.labels])).toEqual([
      ['answered-task', ['otvet']],
      ['labelled-task', ['otvet', 'lora', 'ari']],
    ]);
    expect(
      previous.events.find((event) => event.operationId === 'label-update')!
        .changes.labels,
    ).toEqual({ from: ['otvet', 'ari'], to: ['otvet', 'lora', 'ari'] });
    expect(
      previous.operations.find((op) => op.id === 'label-rejected')!.result,
    ).toMatchObject({
      ok: false,
      code: 'conflict',
      current: { id: 'labelled-task', labels: ['otvet', 'lora', 'ari'] },
    });
  });
  it('drops the label from task rows in place and replays the untouched journal to the same state', async () => {
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db, { migrationsDir: oldMigrations() });
    loadRows(db, previous);
    expect(labelsOf(db)).toEqual({
      'answered-task': ['["otvet"]', 1],
      'labelled-task': ['["otvet","lora","ari"]', 2],
    });
    migrate(db, { logger: { warn: () => {} } });
    expect(() => assertSchema(db)).not.toThrow();
    expect(labelsOf(db)).toEqual({
      'answered-task': ['[]', 1],
      'labelled-task': ['["lora","ari"]', 2],
    });
    expect(
      byId(readState(db).tasks).map((task) => [task.id, task.labels]),
    ).toEqual([
      ['answered-task', []],
      ['labelled-task', ['lora', 'ari']],
    ]);
    expect(exportWorkspace(db).events).toEqual(previous.events);
    expect(() => validateExport(exportWorkspace(db))).not.toThrow();
    const app = appFor(db);
    // Stored results are read as written, and the old envelope repeats them.
    const stored = await app.request('/api/operations/label-rejected');
    expect(stored.status).toBe(200);
    const parsed = storedOperationSchema.parse(await stored.json());
    expect(parsed.result).toMatchObject({
      ok: false,
      current: { labels: ['otvet', 'lora', 'ari'] },
    });
    const repeated = await postMigrationCommand(app, {
      operationId: 'label-rejected',
      generation: getSetting(db, 'generation'),
      command: 'task.update',
      payload: {
        id: 'labelled-task',
        baseRevision: 1,
        note: 'Конфликтующая заметка',
      },
      dryRun: false,
    });
    expect(repeated.status).toBe(409);
    expect(operationResponseSchema.parse(await repeated.json())).toEqual(
      parsed.result,
    );
    // A new command cannot bring the label back; the snapshot has none.
    const refused = await postMigrationCommand(app, {
      operationId: 'otvet-after-migration',
      generation: getSetting(db, 'generation'),
      command: 'task.update',
      payload: { id: 'labelled-task', baseRevision: 2, labels: ['otvet'] },
    });
    expect(refused.status).toBe(400);
    const snapshot = (await (await app.request('/api/snapshot')).json()) as {
      tasks: { labels: string[] }[];
    };
    expect(snapshot.tasks.flatMap((task) => task.labels)).not.toContain(
      'otvet',
    );
    const exported = exportWorkspace(db);
    expect(exported.formatVersion).toBe(FORMAT_VERSION);
    const target = openDatabase(':memory:');
    cleanup.push(() => target.close());
    migrate(target);
    importWorkspace(target, exported);
    expect(readState(target)).toEqual(readState(db));
  });
  it('upgrades and imports a real format-5 export: tasks lose the label, the journal and stored results stay as written', async () => {
    const upgraded = upgradeExport(previousRaw);
    expect(upgraded.formatVersion).toBe(FORMAT_VERSION);
    expect(byId(upgraded.tasks).map((task) => [task.id, task.labels])).toEqual([
      ['answered-task', []],
      ['labelled-task', ['lora', 'ari']],
    ]);
    expect(upgraded.events).toEqual(previous.events);
    expect(upgraded.operations.map((op) => op.result)).toEqual(
      previous.operations.map((op) => op.result),
    );
    expect(() => validateExport(upgraded)).not.toThrow();
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db);
    importWorkspace(db, previous);
    expect(byId(readState(db).tasks)).toEqual(byId(upgraded.tasks));
    const app = appFor(db);
    for (const old of upgraded.operations) {
      const response = await app.request(`/api/operations/${old.id}`);
      expect(response.status).toBe(200);
      expect(storedOperationSchema.parse(await response.json()).result).toEqual(
        old.result,
      );
    }
    expect(() => validateExport(exportWorkspace(db))).not.toThrow();
  });
});

describe('0007_labels', () => {
  // Generated by the unchanged c3c4194 checkout (schema 7, format 6): task
  // rows carry slugs of the catalogue that still lived in code.
  const previousRaw: unknown = JSON.parse(
    readFileSync(
      new URL('../fixtures/export-schema-7.json', import.meta.url),
      'utf8',
    ),
  );
  const previous = previousRaw as z.input<typeof exportSchemaV6>;
  const byId = <T extends { id: string }>(rows: T[]) =>
    rows.toSorted((a, b) => a.id.localeCompare(b.id));
  const oldMigrations = () => {
    const dir = mkdtempSync(join(tmpdir(), 'taskindex-schema-7-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const name of [
      '0000_taskindex.sql',
      '0001_agent_keys.sql',
      '0002_operation_seq.sql',
      '0003_appearance.sql',
      '0004_focus_desk.sql',
      '0005_priority_labels_closes.sql',
      '0006_drop_otvet_label.sql',
    ])
      cpSync(join(migrationsDirectory(), name), join(dir, name));
    return dir;
  };
  it('uses a real format-6 fixture without a catalogue whose tasks carry seeded slugs', () => {
    expect(previous.formatVersion).toBe(6);
    expect(previous.settings.schema_version).toBe('7');
    expect('labels' in previous).toBe(false);
    expect(byId(previous.tasks).map((t) => [t.id, t.labels])).toEqual([
      ['model-task', ['lora', 'ari']],
      ['quick-task', ['5-min']],
    ]);
  });
  it('seeds the catalogue in SQL, leaves task rows untouched and replays the journal from the seeded records', async () => {
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db, { migrationsDir: oldMigrations() });
    loadRows(db, previous);
    expect(
      db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE name='labels'")
        .get(),
    ).toBeUndefined();
    migrate(db, { logger: { warn: () => {} } });
    expect(() => assertSchema(db)).not.toThrow();
    const state = readState(db);
    expect(state.labels).toEqual(SEEDED_LABELS);
    expect(byId(state.tasks).map((t) => [t.id, t.labels, t.revision])).toEqual([
      ['model-task', ['lora', 'ari'], 2],
      ['quick-task', ['5-min'], 1],
    ]);
    expect(exportWorkspace(db).events).toEqual(previous.events);
    expect(() => validateExport(exportWorkspace(db))).not.toThrow();
    const app = appFor(db);
    const stored = await app.request('/api/operations/catalogue-rejected');
    expect(stored.status).toBe(200);
    const parsed = storedOperationSchema.parse(await stored.json());
    expect(parsed.result).toMatchObject({
      ok: false,
      current: { id: 'model-task', labels: ['lora', 'ari'] },
    });
    // The catalogue is live: a seeded label can be renamed and archived, and
    // the journal still validates from the seeded records.
    const renamed = await postMigrationCommand(app, {
      operationId: 'rename-after-0007',
      generation: getSetting(db, 'generation'),
      command: 'label.update',
      payload: { id: 'ari', baseRevision: 1, name: 'Ари' },
    });
    expect(renamed.status).toBe(200);
    const archived = await postMigrationCommand(app, {
      operationId: 'archive-after-0007',
      generation: getSetting(db, 'generation'),
      command: 'label.archive',
      payload: { id: 'lora', baseRevision: 1 },
    });
    expect(archived.status).toBe(200);
    expect(
      readState(db).tasks.find((t) => t.id === 'model-task')!.labels,
    ).toEqual(['ari']);
    const exported = exportWorkspace(db);
    expect(exported.formatVersion).toBe(FORMAT_VERSION);
    expect(() => validateExport(exported)).not.toThrow();
    const target = openDatabase(':memory:');
    cleanup.push(() => target.close());
    migrate(target);
    importWorkspace(target, exported);
    expect(readState(target)).toEqual(readState(db));
  });
  it('upgrades and imports a real format-6 export by adding the seeded catalogue', async () => {
    const upgraded = upgradeExport(previousRaw);
    expect(upgraded.formatVersion).toBe(FORMAT_VERSION);
    expect(upgraded.labels).toEqual(SEEDED_LABELS);
    expect(byId(upgraded.tasks).map((t) => [t.id, t.labels])).toEqual([
      ['model-task', ['lora', 'ari']],
      ['quick-task', ['5-min']],
    ]);
    expect(upgraded.events).toEqual(previous.events);
    expect(() => validateExport(upgraded)).not.toThrow();
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db);
    importWorkspace(db, previous);
    expect(readState(db).labels).toEqual(SEEDED_LABELS);
    expect(byId(readState(db).tasks)).toEqual(byId(upgraded.tasks));
    expect(() => validateExport(exportWorkspace(db))).not.toThrow();
  });
});
describe('0008_steps', () => {
  // Generated by the unchanged cf576a1 checkout (schema 8, format 7): steps
  // as rows of text, tick and position; an owner's edit of one step marked
  // `checklist` on the task; an agent reordered with the flag; a stale add
  // is a stored conflict whose record carries the old checklist shape.
  const previousRaw: unknown = JSON.parse(
    readFileSync(
      new URL('../fixtures/export-schema-8.json', import.meta.url),
      'utf8',
    ),
  );
  const previous = previousRaw as z.input<typeof exportSchemaV7>;
  const byId = <T extends { id: string }>(rows: T[]) =>
    rows.toSorted((a, b) => a.id.localeCompare(b.id));
  const oldMigrations = () => {
    const dir = mkdtempSync(join(tmpdir(), 'taskindex-schema-8-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const name of [
      '0000_taskindex.sql',
      '0001_agent_keys.sql',
      '0002_operation_seq.sql',
      '0003_appearance.sql',
      '0004_focus_desk.sql',
      '0005_priority_labels_closes.sql',
      '0006_drop_otvet_label.sql',
      '0007_labels.sql',
    ])
      cpSync(join(migrationsDirectory(), name), join(dir, name));
    return dir;
  };
  // What the migration must make of the fixture rows: keys by position,
  // bookkeeping from the parent task, revision 1, nothing owner-protected.
  const expectedSteps = [
    ['plan-1', 'a0', true],
    ['plan-3', 'a1', false],
    ['plan-2', 'a2', false],
  ];
  it('uses a real format-7 fixture with step rows, an owner-marked checklist and a stored conflict', () => {
    expect(previous.formatVersion).toBe(7);
    expect(previous.settings.schema_version).toBe('8');
    expect('steps' in previous).toBe(false);
    expect(
      previous.checklistItems
        .toSorted((a, b) => a.position - b.position)
        .map((row) => [row.id, row.position, row.done]),
    ).toEqual([
      ['plan-1', 0, true],
      ['plan-3', 1, false],
      ['plan-2', 2, false],
    ]);
    expect(
      previous.tasks.find((t) => t.id === 'plan-task')!.ownerFields,
    ).toContain('checklist');
    const rejected = previous.operations.find((o) => o.id === 'plan-rejected')!;
    expect(rejected.result).toMatchObject({ ok: false, code: 'conflict' });
    const current = (rejected.result as { current: { checklist: unknown[] } })
      .current;
    expect(current.checklist).toHaveLength(3);
    expect(current.checklist[0]).toEqual({
      id: 'plan-1',
      text: 'Поднять контейнер',
      done: true,
    });
  });
  it('rebuilds the step rows as records in SQL, frees the task of the checklist entry and replays the old journal to the same state', async () => {
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db, { migrationsDir: oldMigrations() });
    loadRows(db, previous);
    migrate(db, { logger: { warn: () => {} } });
    expect(() => assertSchema(db)).not.toThrow();
    const state = readState(db);
    const task = state.tasks.find((t) => t.id === 'plan-task')!;
    expect(
      state.steps
        .toSorted((a, b) => a.orderKey.localeCompare(b.orderKey))
        .map((s) => [s.id, s.orderKey, s.done]),
    ).toEqual(expectedSteps);
    for (const step of state.steps)
      expect(step).toMatchObject({
        taskId: 'plan-task',
        doneAt: null,
        doneBy: null,
        doneByLabel: null,
        result: '',
        linkedTaskId: null,
        removedAt: null,
        createdBy: task.createdBy,
        createdByLabel: task.createdByLabel,
        ownerTouchedAt: null,
        ownerFields: [],
        revision: 1,
        createdAt: task.createdAt,
        updatedAt: task.createdAt,
      });
    expect(task.checklist.map((i) => [i.id, i.done, i.revision])).toEqual([
      ['plan-1', true, 1],
      ['plan-3', false, 1],
      ['plan-2', false, 1],
    ]);
    expect(task.ownerFields).not.toContain('checklist');
    expect(task.ownerFields).toContain('title');
    expect(exportWorkspace(db).events).toEqual(previous.events);
    expect(() => validateExport(exportWorkspace(db))).not.toThrow();
    const app = appFor(db);
    // The stored conflict is read as written: its record carries the old
    // checklist shape, which the task schema fills with defaults.
    const stored = await app.request('/api/operations/plan-rejected');
    expect(stored.status).toBe(200);
    const parsed = storedOperationSchema.parse(await stored.json());
    expect(parsed.result).toMatchObject({
      ok: false,
      current: { id: 'plan-task' },
    });
    const storedCurrent = (
      parsed.result as { current: { checklist: unknown[] } }
    ).current;
    expect(storedCurrent.checklist).toHaveLength(3);
    expect(storedCurrent.checklist[0]).toEqual({
      id: 'plan-1',
      text: 'Поднять контейнер',
      done: true,
      doneAt: null,
      doneBy: null,
      doneByLabel: null,
      result: '',
      linkedTaskId: null,
      revision: 1,
    });
    // Steps are live records now: a new key fits between the backfilled
    // ones, an agent ticks a step without the flag the old model demanded.
    const added = await postMigrationCommand(app, {
      operationId: 'add-after-0008',
      generation: getSetting(db, 'generation'),
      command: 'checklist.add',
      payload: {
        taskId: 'plan-task',
        id: 'plan-4',
        text: 'Между шагами',
        position: 1,
      },
    });
    expect(added.status).toBe(200);
    expect(
      readState(db)
        .tasks.find((t) => t.id === 'plan-task')!
        .checklist.map((i) => i.id),
    ).toEqual(['plan-1', 'plan-4', 'plan-3', 'plan-2']);
    const exported = exportWorkspace(db);
    expect(exported.formatVersion).toBe(FORMAT_VERSION);
    expect(() => validateExport(exported)).not.toThrow();
    const target = openDatabase(':memory:');
    cleanup.push(() => target.close());
    migrate(target);
    importWorkspace(target, exported);
    expect(readState(target)).toEqual(readState(db));
  });
  it('upgrades and imports a real format-7 export into the same step records as the SQL migration', async () => {
    const upgraded = upgradeExport(previousRaw);
    expect(upgraded.formatVersion).toBe(FORMAT_VERSION);
    expect(
      upgraded.steps
        .toSorted((a, b) => a.orderKey.localeCompare(b.orderKey))
        .map((s) => [s.id, s.orderKey, s.done]),
    ).toEqual(expectedSteps);
    expect(
      upgraded.tasks.find((t) => t.id === 'plan-task')!.ownerFields,
    ).not.toContain('checklist');
    expect(upgraded.events).toEqual(previous.events);
    expect(() => validateExport(upgraded)).not.toThrow();
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db);
    importWorkspace(db, previous);
    const migrated = openDatabase(':memory:');
    cleanup.push(() => migrated.close());
    migrate(migrated, { migrationsDir: oldMigrations() });
    loadRows(migrated, previous);
    migrate(migrated, { logger: { warn: () => {} } });
    expect(byId(readState(db).steps)).toEqual(byId(readState(migrated).steps));
    expect(byId(readState(db).tasks)).toEqual(byId(readState(migrated).tasks));
    expect(() => validateExport(exportWorkspace(db))).not.toThrow();
  });
});
describe('0009_proposals', () => {
  // Generated by the unchanged f2ab3d5 checkout (schema 9, format 8): a past
  // visit with the date in its title, an agent's task with steps the owner
  // renamed, an owner's comment, an archived task and a stored conflict. No
  // proposals existed; the migration only adds their table.
  const previousRaw: unknown = JSON.parse(
    readFileSync(
      new URL('../fixtures/export-schema-9.json', import.meta.url),
      'utf8',
    ),
  );
  const previous = previousRaw as z.input<typeof exportSchemaV8>;
  const oldMigrations = () => {
    const dir = mkdtempSync(join(tmpdir(), 'taskindex-schema-9-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const name of readdirSync(migrationsDirectory()))
      if (name.endsWith('.sql') && name < '0009')
        cpSync(join(migrationsDirectory(), name), join(dir, name));
    expect(schemaVersion(dir)).toBe(9);
    return dir;
  };
  const migrated = () => {
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db, { migrationsDir: oldMigrations() });
    loadRows(db, previous);
    migrate(db, { logger: { warn: () => {} } });
    return db;
  };
  it('uses a real format-8 fixture without proposals, with steps and a stored conflict', () => {
    expect(previous.formatVersion).toBe(8);
    expect(previous.settings.schema_version).toBe('9');
    expect('proposals' in previous).toBe(false);
    expect(previous.steps.map((s) => s.id)).toEqual([
      'agent-step-1',
      'agent-step-2',
    ]);
    const rejected = previous.operations.find(
      (o) => o.id === 'agent-rejected',
    )!;
    expect(rejected.result).toMatchObject({ ok: false, code: 'conflict' });
  });
  it('adds an empty proposal table to a schema-9 database, keeps its journal and takes a proposal on the migrated board', async () => {
    const db = migrated();
    expect(() => assertSchema(db)).not.toThrow();
    expect(readState(db).proposals).toEqual([]);
    expect(exportWorkspace(db).events).toEqual(previous.events);
    expect(() => validateExport(exportWorkspace(db))).not.toThrow();
    const app = appFor(db);
    const generation = getSetting(db, 'generation');
    const post = async (operationId: string, body: Record<string, unknown>) => {
      const response = await postMigrationCommand(app, {
        operationId,
        generation,
        ...body,
      });
      expect(response.status).toBe(200);
    };
    await post('propose-visit', {
      command: 'proposal.create',
      payload: {
        kind: 'task_change',
        command: {
          command: 'task.archive',
          payload: { id: 'visit-task', baseRevision: 1 },
        },
        reason: 'Дата в названии прошла 4 дня назад',
        evidence: [
          {
            source: 'board',
            ref: 'visit-task',
            at: '2026-09-25',
            quote: 'Стрижка 21.09',
          },
        ],
        fingerprint: 'audit:dated:visit-task:2026-09-21',
        rank: 3,
      },
    });
    await post('deliver', { command: 'proposal.deliver', payload: {} });
    await post('accept', { command: 'proposal.accept', payload: { ref: '1' } });
    const state = readState(db);
    expect(state.tasks.find((t) => t.id === 'visit-task')!.archived).toBe(true);
    expect(state.proposals[0]).toMatchObject({
      status: 'accepted',
      resultTaskId: 'visit-task',
    });
    const exported = exportWorkspace(db);
    expect(exported.formatVersion).toBe(FORMAT_VERSION);
    expect(() => validateExport(exported)).not.toThrow();
    const target = openDatabase(':memory:');
    cleanup.push(() => target.close());
    migrate(target);
    importWorkspace(target, exported);
    expect(readState(target)).toEqual(readState(db));
  });
  it('upgrades and imports a real format-8 export with no proposals, the same state the SQL migration gives', () => {
    const upgraded = upgradeExport(previousRaw);
    expect(upgraded.formatVersion).toBe(FORMAT_VERSION);
    expect(upgraded.proposals).toEqual([]);
    expect(upgraded.events).toEqual(previous.events);
    expect(() => validateExport(upgraded)).not.toThrow();
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db);
    importWorkspace(db, previousRaw as Record<string, unknown>);
    const byId = <T extends { id: string }>(rows: T[]) =>
      rows.toSorted((a, b) => a.id.localeCompare(b.id));
    const fromSql = readState(migrated());
    const imported = readState(db);
    expect(byId(imported.tasks)).toEqual(byId(fromSql.tasks));
    expect(byId(imported.steps)).toEqual(byId(fromSql.steps));
    expect(byId(imported.comments)).toEqual(byId(fromSql.comments));
    expect(byId(imported.labels)).toEqual(byId(fromSql.labels));
    expect(imported.proposals).toEqual([]);
  });
});
