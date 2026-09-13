import { afterEach, describe, it, expect } from 'vitest';
import { fixture, success } from './helpers.js';
import {
  generation,
  getSetting,
  latestSeq,
  migrate,
  schemaVersion,
  setSetting,
} from '../../src/server/db.js';
import {
  openWrites,
  markRestored,
  exportWorkspace,
  importWorkspace,
} from '../../src/server/admin.js';
import { applyEvent } from '../../src/shared/commands.js';
import { snapshotSchema } from '../../src/shared/domain-schemas.js';
import { defaultAppearance } from '../../src/shared/domain-schemas.js';
import type {
  OperationSuccess,
  Task,
  WorkspaceState,
} from '../../src/shared/model.js';
const cleanups: (() => void)[] = [];
function setup(mode: 'held' | 'open' = 'open') {
  const f = fixture(mode);
  cleanups.push(f.close);
  return f;
}
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
describe('transactional commands', () => {
  it('preserves Focus through retries, stale edits, snapshot and archive restoration', async () => {
    const f = setup();
    await f.post({
      command: 'task.create',
      payload: { id: 'focused', area: 'agency', title: 'Задача' },
    });
    const command = {
      command: 'task.update' as const,
      payload: { id: 'focused', baseRevision: 1, focus: true },
    };
    const focused = await f.post(command, { id: 'select-focus' });
    expect(focused.status).toBe(200);
    expect(await f.post(command, { id: 'select-focus' })).toEqual(focused);
    const stale = await f.post({
      command: 'task.update',
      payload: { id: 'focused', baseRevision: 1, focus: false },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'conflict',
      current: { focus: true },
    });
    const snapshot = await (await f.app.request('/api/snapshot')).json();
    expect(snapshot).toMatchObject({ tasks: [{ id: 'focused', focus: true }] });
    expect(
      (
        await f.post({
          command: 'task.archive',
          payload: { id: 'focused', baseRevision: 2 },
        })
      ).status,
    ).toBe(200);
    // Archiving leaves the desk (plan 13); restoring does not return to it.
    expect(f.state().tasks[0]).toMatchObject({
      focus: false,
      focusKey: null,
      archived: true,
    });
    expect(
      (
        await f.post({
          command: 'task.restore',
          payload: { id: 'focused', baseRevision: 3 },
        })
      ).status,
    ).toBe(200);
    expect(f.state().tasks[0]).toMatchObject({ focus: false, archived: false });
  });
  it('commits once, replays the exact result, and rejects changed envelopes', async () => {
    const f = setup();
    const command = {
      command: 'task.create' as const,
      payload: { id: 't', area: 'agency' as const, title: 'Задача' },
    };
    const first = await f.post(command, { id: 'op' });
    expect(first.status).toBe(200);
    expect(await f.post(command, { id: 'op' })).toEqual(first);
    const mismatch = await f.post(
      { ...command, payload: { ...command.payload, title: 'Другая' } },
      { id: 'op' },
    );
    expect(mismatch.status).toBe(409);
    expect(f.state().tasks).toHaveLength(1);
    expect(latestSeq(f.db)).toBe(1);
  });
  it('merges disjoint fields and rejects intersecting edits without partial saves', async () => {
    const f = setup();
    await f.post({
      command: 'task.create',
      payload: { id: 't', area: 'agency', title: 'Исходная' },
    });
    await f.post({
      command: 'task.update',
      payload: { id: 't', baseRevision: 1, note: 'Отчёт' },
    });
    expect(
      (
        await f.post({
          command: 'task.update',
          payload: { id: 't', baseRevision: 1, title: 'Название' },
        })
      ).status,
    ).toBe(200);
    await f.post({
      command: 'checklist.add',
      payload: { taskId: 't', baseRevision: 3, id: 'step', text: 'Шаг' },
    });
    const conflict = await f.post({
      command: 'task.save',
      payload: {
        id: 't',
        baseRevision: 3,
        fields: { title: 'Не записывать' },
        checklist: [],
      },
    });
    expect(conflict.status).toBe(409);
    expect(f.state().tasks[0]!.title).toBe('Название');
    expect(f.state().tasks[0]!.checklist).toHaveLength(1);
    expect(
      (
        await f.post({
          command: 'task.update',
          payload: { id: 't', baseRevision: 100, title: 'Будущее' },
        })
      ).status,
    ).toBe(400);
  });
  it('moves area and project atomically, maintains Russian uniqueness and ordering', async () => {
    const f = setup();
    await f.post({
      command: 'project.create',
      payload: {
        id: 'p',
        area: 'development',
        name: 'Проект',
        color: '#aaBBcc',
      },
    });
    expect(
      (
        await f.post({
          command: 'project.create',
          payload: { area: 'development', name: ' ПРОЕКТ ', color: '#aabbcc' },
        })
      ).status,
    ).toBe(409);
    await f.post({
      command: 'task.create',
      payload: { id: 't', area: 'agency', title: 'Задача' },
    });
    expect(
      (
        await f.post({
          command: 'task.save',
          payload: {
            id: 't',
            baseRevision: 1,
            fields: { projectId: 'p', title: 'Не записывать' },
          },
        })
      ).status,
    ).toBe(400);
    expect(f.state().tasks[0]!.title).toBe('Задача');
    const moved = success(
      await f.post({
        command: 'task.save',
        payload: {
          id: 't',
          baseRevision: 1,
          fields: { area: 'development', projectId: 'p' },
        },
      }),
    );
    expect((moved.results[0]!.record as Task).area).toBe('development');
  });
  it('rolls back the entire batch, persists a final rejection, and dryRun writes nothing', async () => {
    const f = setup();
    const failed = await f.batch(
      [
        {
          command: 'task.create',
          payload: { id: 'a', area: 'agency', title: 'A' },
        },
        {
          command: 'task.update',
          payload: { id: 'missing', baseRevision: 1, title: 'B' },
        },
      ],
      { id: 'bad' },
    );
    expect(failed.status).toBe(404);
    expect(f.state().tasks).toEqual([]);
    expect(latestSeq(f.db)).toBe(0);
    expect((await f.app.request('/api/operations/bad')).status).toBe(200);
    const dry = success(
      await f.batch(
        [
          {
            command: 'task.create',
            payload: { id: 'a', area: 'agency', title: 'A' },
          },
          {
            command: 'task.update',
            payload: { id: 'a', baseRevision: 1, title: 'B' },
          },
        ],
        { id: 'dry', dryRun: true },
      ),
    );
    expect(dry.events).toEqual([]);
    expect((dry.results[1]!.record as Task).title).toBe('B');
    expect(f.state().tasks).toEqual([]);
    expect((await f.app.request('/api/operations/dry')).status).toBe(404);
  });
  it('rejects wrong generation before recording an operation', async () => {
    const f = setup();
    const r = await f.batch(
      [
        {
          command: 'task.create',
          payload: { id: 't', area: 'agency', title: 'T' },
        },
      ],
      { gen: 'old', id: 'stale' },
    );
    expect(r.status).toBe(409);
    expect(f.state().tasks).toEqual([]);
    expect((await f.app.request('/api/operations/stale')).status).toBe(404);
  });
  it('held is retryable, not persisted, and deployment approval survives app recreation', async () => {
    const f = setup('held');
    const command = {
      command: 'task.create' as const,
      payload: { id: 't', area: 'agency' as const, title: 'T' },
    };
    const r = await f.post(command, { id: 'held-op' });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ retryable: true, code: 'unavailable' });
    expect((await f.app.request('/api/operations/held-op')).status).toBe(404);
    openWrites(f.db, 'test-deploy');
    expect((await f.post(command, { id: 'held-op' })).status).toBe(200);
    markRestored(f.db);
    expect(getSetting(f.db, 'approved_deployment')).toBeUndefined();
    expect((await f.post(command, { id: 'new' })).status).toBe(503);
  });
  it('enforces scopes on commands and the net effects of undo', async () => {
    const f = setup();
    expect(
      (
        await f.post(
          {
            command: 'project.create',
            payload: { area: 'agency', name: 'X', color: '#112233' },
          },
          { role: 'tasks' },
        )
      ).status,
    ).toBe(403);
    const created = success(
      await f.post({
        command: 'project.create',
        payload: { id: 'p', area: 'agency', name: 'P', color: '#112233' },
      }),
    );
    expect(created.events).toHaveLength(1);
    await f.post(
      {
        command: 'project.update',
        payload: { id: 'p', baseRevision: 1, name: 'New' },
      },
      { id: 'project-change' },
    );
    expect(
      (
        await f.post(
          { command: 'undo', payload: { operationId: 'project-change' } },
          { role: 'tasks' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.post(
          { command: 'task.create', payload: { area: 'agency', title: 'X' } },
          { role: 'read' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.app.request('/api/snapshot', {
          headers: { 'x-test-role': 'none' },
        })
      ).status,
    ).toBe(401);
  });
  it('never relabels a newer or unknown migration as schema1', () => {
    const f = setup();
    const newer = String(schemaVersion() + 1);
    setSetting(f.db, 'schema_version', newer);
    expect(() => migrate(f.db)).toThrow();
    expect(getSetting(f.db, 'schema_version')).toBe(newer);
    setSetting(f.db, 'schema_version', String(schemaVersion()));
    f.db.sqlite
      .prepare('INSERT INTO __taskindex_migrations(name) VALUES(?)')
      .run('future.sql');
    expect(() => migrate(f.db)).toThrow();
  });
});
describe('source synchronization and undo', () => {
  it('deduplicates origins including archive and fails closed on unknown freshness', async () => {
    const f = setup();
    const origin = { system: 'telegram', ref: 'msg' };
    await f.post(
      {
        command: 'task.sync',
        payload: { origin, fields: { area: 'agency', title: 'Первое' } },
      },
      { role: 'agent' },
    );
    const unknown = success(
      await f.post(
        {
          command: 'task.sync',
          payload: { origin, fields: { area: 'agency', title: 'Старый кеш' } },
        },
        { role: 'agent' },
      ),
    );
    expect(unknown.results[0]).toMatchObject({
      skipped: 'all',
      reason: 'freshness_unknown',
    });
    expect(unknown.events).toEqual([]);
    const task = f.state().tasks[0]!;
    await f.post({
      command: 'task.archive',
      payload: { id: task.id, baseRevision: task.revision },
    });
    const duplicate = success(
      await f.post({
        command: 'task.create',
        payload: { area: 'agency', title: 'Дубль', origin },
      }),
    );
    expect(duplicate.results[0]!.existing).toBe(true);
    expect(f.state().tasks).toHaveLength(1);
  });
  it('keeps owner decisions, source watermark, and explicit correction available', async () => {
    const f = setup();
    const origin = { system: 'telegram', ref: 'msg', version: '1' };
    await f.post(
      {
        command: 'task.sync',
        payload: {
          origin,
          fields: { area: 'agency', title: 'Первое', note: 'A' },
        },
      },
      { role: 'agent' },
    );
    let t = f.state().tasks[0]!;
    expect(t.ownerTouchedAt).toBeNull();
    await f.post({
      command: 'task.save',
      payload: {
        id: t.id,
        baseRevision: 1,
        fields: { title: 'Ручное' },
        status: 'done',
      },
    });
    const synced = success(
      await f.post(
        {
          command: 'task.sync',
          payload: {
            origin: { ...origin, version: '2' },
            fields: {
              area: 'agency',
              title: 'Не затирать',
              status: 'todo',
              note: 'B',
            },
          },
        },
        { role: 'agent', id: 'sync-two' },
      ),
    );
    t = f.state().tasks[0]!;
    expect(t).toMatchObject({
      title: 'Ручное',
      status: 'done',
      note: 'B',
      originVersion: '2',
    });
    expect(synced.results[0]!.skipped).toEqual(
      expect.arrayContaining([
        { field: 'title', reason: 'owner' },
        { field: 'status', reason: 'owner' },
      ]),
    );
    await f.post({ command: 'undo', payload: { operationId: 'sync-two' } });
    t = f.state().tasks[0]!;
    expect(t.note).toBe('A');
    expect(t.originVersion).toBe('2');
    const stale = success(
      await f.post(
        {
          command: 'task.sync',
          payload: {
            origin: { ...origin, version: '2' },
            fields: { area: 'agency', title: 'Снова', note: 'B' },
          },
        },
        { role: 'agent' },
      ),
    );
    expect(stale.results[0]!.reason).toBe('stale');
    // An explicit correction of an owner field is available to the agent only
    // with the confirmation flag in the envelope (TI-027).
    const unconfirmed = await f.post(
      {
        command: 'task.update',
        payload: { id: t.id, baseRevision: t.revision, note: 'Осознанно' },
      },
      { role: 'agent' },
    );
    expect(unconfirmed.status).toBe(403);
    expect(unconfirmed.body).toMatchObject({
      code: 'forbidden',
      conflicts: [{ entityKind: 'task', entityId: t.id, fields: ['note'] }],
    });
    expect(
      (
        await f.post(
          {
            command: 'task.update',
            payload: { id: t.id, baseRevision: t.revision, note: 'Осознанно' },
          },
          { role: 'agent', confirmOwnerFields: true },
        )
      ).status,
    ).toBe(200);
  });
  it('metadata-only sync does not conflict with a draft or become an undo target', async () => {
    const f = setup();
    const origin = { system: 'hub', ref: '1', version: '1' };
    await f.post(
      {
        command: 'task.sync',
        payload: { origin, fields: { area: 'agency', title: 'T' } },
      },
      { role: 'agent' },
    );
    const t = f.state().tasks[0]!;
    const second = success(
      await f.post(
        {
          command: 'task.sync',
          payload: {
            origin: { ...origin, version: '2' },
            fields: { area: 'agency', title: 'T' },
          },
        },
        { role: 'agent' },
      ),
    );
    expect(second.events).toHaveLength(1);
    expect(
      (
        await f.post({
          command: 'task.update',
          payload: { id: t.id, baseRevision: 1, note: 'Черновик' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.post({
          command: 'undo',
          payload: { seq: second.events[0]!.seq },
        })
      ).status,
    ).toBe(409);
  });
  it('undo restores position and rejects a now occupied original key', async () => {
    const f = setup();
    for (const id of ['a', 'b', 'c'])
      await f.post({
        command: 'task.create',
        payload: { id, area: 'agency', title: id },
      });
    const oldKey = f.state().tasks.find((t) => t.id === 'b')!.orderKey;
    await f.post(
      {
        command: 'task.move',
        payload: { id: 'b', baseRevision: 1, status: 'done' },
      },
      { id: 'move' },
    );
    expect(
      (await f.post({ command: 'undo', payload: { operationId: 'move' } }))
        .status,
    ).toBe(200);
    expect(f.state().tasks.find((t) => t.id === 'b')!.orderKey).toBe(oldKey);
    await f.post(
      {
        command: 'task.move',
        payload: { id: 'b', baseRevision: 3, status: 'done' },
      },
      { id: 'move2' },
    );
    f.db.sqlite
      .prepare('UPDATE tasks SET order_key=? WHERE id=?')
      .run(oldKey, 'c');
    expect(
      (await f.post({ command: 'undo', payload: { operationId: 'move2' } }))
        .status,
    ).toBe(409);
    expect(f.state().tasks.find((t) => t.id === 'b')!.status).toBe('done');
  });
  it('operation undo folds nullable A→B→C and handles task/comment creation lifecycle', async () => {
    const f = setup();
    await f.post({
      command: 'task.create',
      payload: { id: 't', area: 'agency', title: 'T' },
    });
    await f.batch(
      [
        {
          command: 'task.update',
          payload: { id: 't', baseRevision: 1, due: '2026-09-10' },
        },
        {
          command: 'task.update',
          payload: { id: 't', baseRevision: 2, due: '2026-09-12' },
        },
      ],
      { id: 'chain' },
    );
    expect(
      (await f.post({ command: 'undo', payload: { operationId: 'chain' } }))
        .status,
    ).toBe(200);
    expect(f.state().tasks[0]!.due).toBeNull();
    await f.batch(
      [
        {
          command: 'task.create',
          payload: { id: 'new', area: 'personal', title: 'Initial' },
        },
        {
          command: 'task.update',
          payload: { id: 'new', baseRevision: 1, title: 'Final' },
        },
        {
          command: 'comment.add',
          payload: { id: 'comment', taskId: 'new', text: 'Отчёт' },
        },
      ],
      { id: 'creation', role: 'agent' },
    );
    const undo = success(
      await f.post({ command: 'undo', payload: { operationId: 'creation' } }),
    );
    expect(undo.events).toHaveLength(2);
    expect(f.state().tasks.find((t) => t.id === 'new')).toMatchObject({
      archived: true,
      title: 'Final',
      commentCount: 0,
    });
    expect(f.state().comments[0]!.deletedAt).not.toBeNull();
    await f.post({
      command: 'undo',
      payload: { operationId: undo.operationId },
    });
    expect(f.state().tasks.find((t) => t.id === 'new')!.archived).toBe(false);
  });
  it('rejects entire undo if one record was changed later', async () => {
    const f = setup();
    await f.batch([
      {
        command: 'task.create',
        payload: { id: 'a', area: 'agency', title: 'A' },
      },
      {
        command: 'task.create',
        payload: { id: 'b', area: 'agency', title: 'B' },
      },
    ]);
    await f.batch(
      [
        {
          command: 'task.update',
          payload: { id: 'a', baseRevision: 1, title: 'AA' },
        },
        {
          command: 'task.update',
          payload: { id: 'b', baseRevision: 1, title: 'BB' },
        },
      ],
      { id: 'edit' },
    );
    await f.post({
      command: 'task.update',
      payload: { id: 'b', baseRevision: 2, title: 'Later' },
    });
    expect(
      (await f.post({ command: 'undo', payload: { operationId: 'edit' } }))
        .status,
    ).toBe(409);
    expect(f.state().tasks.find((t) => t.id === 'a')!.title).toBe('AA');
  });
});
describe('comments, snapshots, export and stream', () => {
  it('comments never bump task revision; second delete is a no-event success', async () => {
    const f = setup();
    await f.post({
      command: 'task.create',
      payload: { id: 't', area: 'agency', title: 'T' },
    });
    await Promise.all([
      f.post(
        {
          command: 'comment.add',
          payload: { id: 'c1', taskId: 't', text: 'Один' },
        },
        { role: 'agent' },
      ),
      f.post(
        {
          command: 'comment.add',
          payload: { id: 'c2', taskId: 't', text: 'Два' },
        },
        { role: 'agent' },
      ),
      f.post({
        command: 'task.update',
        payload: { id: 't', baseRevision: 1, title: 'Изменено' },
      }),
    ]);
    expect(f.state().tasks[0]).toMatchObject({ revision: 2, commentCount: 2 });
    await f.post({ command: 'comment.remove', payload: { commentId: 'c1' } });
    const noOp = success(
      await f.post({ command: 'comment.remove', payload: { commentId: 'c1' } }),
    );
    expect(noOp.events).toEqual([]);
    expect(noOp.firstSeq).toBeNull();
    expect(f.state().tasks[0]).toMatchObject({ revision: 2, commentCount: 1 });
  });
  it('agent cannot remove another author’s comment directly or via undo', async () => {
    const f = setup();
    await f.post({
      command: 'task.create',
      payload: { id: 't', area: 'agency', title: 'T' },
    });
    const comment = success(
      await f.post({
        command: 'comment.add',
        payload: { id: 'c', taskId: 't', text: 'Моё' },
      }),
    );
    expect(
      (
        await f.post(
          { command: 'comment.remove', payload: { commentId: 'c' } },
          { role: 'agent' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.post(
          { command: 'undo', payload: { seq: comment.events[0]!.seq } },
          { role: 'agent' },
        )
      ).status,
    ).toBe(403);
  });
  it('publishes operation boundaries and comment taskId; projection matches committed state', async () => {
    const f = setup();
    const body = success(
      await f.batch([
        {
          command: 'task.create',
          payload: { id: 't', area: 'agency', title: 'T' },
        },
        {
          command: 'comment.add',
          payload: { id: 'c', taskId: 't', text: 'C' },
        },
        {
          command: 'task.update',
          payload: { id: 't', baseRevision: 1, note: 'N' },
        },
      ]),
    );
    expect(body.events.map((e) => [e.firstSeq, e.lastSeq])).toEqual([
      [1, 3],
      [1, 3],
      [1, 3],
    ]);
    expect(body.events[1]!.taskId).toBe('t');
    const projection = body.events.reduce(applyEvent, {
      tasks: [],
      projects: [],
      comments: [],
      appearance: [defaultAppearance()],
    } as WorkspaceState);
    expect(projection).toEqual(f.state());
    const response = await f.app.request('/api/snapshot');
    expect(snapshotSchema.safeParse(await response.json()).success).toBe(true);
  });
  // Ж1 (plan 09, step 6): the journal is the only copy of the events. The
  // stored result keeps everything else, so reads and repeats look the same.
  it('stores an operation result without its events and rebuilds them on read', async () => {
    const f = setup();
    const note = 'з'.repeat(1000);
    const created = success(
      await f.post(
        {
          command: 'task.create',
          payload: { id: 'big', area: 'agency', title: 'Заметка', note },
        },
        { id: 'op-big' },
      ),
    );
    const row = f.db.sqlite
      .prepare(
        "SELECT result, json_extract(result, '$.events') AS e, LENGTH(result) AS n FROM operations WHERE id=?",
      )
      .get('op-big') as { result: string; e: string | null; n: number };
    expect(row.e).toBe(null);
    // The plan expected under 500 bytes; a task.create result also carries the
    // record and the changes, so the note stays there twice out of three
    // copies. What the step removes is the third one, the journal copy.
    expect(row.n).toBeLessThan(JSON.stringify(created).length * 0.75);
    // Fields added to tasks legitimately grow the response. Check the stored
    // content instead of a byte ceiling tied to an earlier task shape.
    const { events: _events, ...withoutEvents } = created;
    expect(JSON.parse(row.result)).toEqual(withoutEvents);
    const stored = (await (
      await f.app.request('/api/operations/op-big')
    ).json()) as { result: OperationSuccess };
    expect(stored.result.events).toHaveLength(1);
    expect(stored.result.events[0]!.changes.note!.to).toBe(note);
    expect(stored.result).toEqual(created);
    const repeat = await f.post(
      {
        command: 'task.create',
        payload: { id: 'big', area: 'agency', title: 'Заметка', note },
      },
      { id: 'op-big' },
    );
    expect(repeat.body).toEqual(created);
  });
  it('reads an operation written before the events left the result', async () => {
    const f = setup();
    const created = success(
      await f.post(
        {
          command: 'task.create',
          payload: { id: 'old', area: 'agency', title: 'Старая' },
        },
        { id: 'op-old' },
      ),
    );
    // The row a previous version wrote: the events inside the result.
    f.db.sqlite
      .prepare('UPDATE operations SET result=? WHERE id=?')
      .run(JSON.stringify(created), 'op-old');
    const stored = (await (
      await f.app.request('/api/operations/op-old')
    ).json()) as {
      result: OperationSuccess;
      taskCount: number;
      titles: string[];
    };
    expect(stored.result).toEqual(created);
    expect(stored.taskCount).toBe(1);
    expect(stored.titles).toEqual(['Старая']);
  });
  it('roundtrips complete data and changes generation without author credentials', async () => {
    const f = setup();
    await f.post({
      command: 'task.create',
      payload: {
        id: 't',
        area: 'agency',
        title: 'T',
        checklist: [{ id: 'c', text: 'Step', done: true }],
      },
    });
    await f.post({
      command: 'comment.add',
      payload: { taskId: 't', text: 'Report' },
    });
    const data = exportWorkspace(f.db);
    const fresh = setup();
    const old = generation(fresh.db);
    importWorkspace(fresh.db, data);
    expect(generation(fresh.db)).not.toBe(old);
    expect(fresh.state()).toEqual(f.state());
    expect(exportWorkspace(fresh.db).events.map((e) => e.seq)).toEqual(
      data.events.map((e) => e.seq),
    );
    expect(fresh.db.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
  it('SSE replays backlog and resets a foreign generation', async () => {
    const f = setup();
    await f.post({
      command: 'task.create',
      payload: { id: 't', area: 'agency', title: 'T' },
    });
    const response = await f.app.request(
      `/api/events/stream?generation=${generation(f.db)}&since=0`,
    );
    const reader = response.body!.getReader();
    await reader.read(); // Initial connection comment flushes headers.
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toContain(
      `id: ${generation(f.db)}:1`,
    );
    await reader.cancel();
    const reset = await f.app.request(
      '/api/events/stream?generation=old&since=0',
    );
    expect(await reset.text()).toContain('event: reset');
  });
  it('OpenAPI contains concrete command and entity schemas', async () => {
    const f = setup();
    const response = await f.app.request('/api/openapi.json');
    expect(response.status).toBe(200);
    const document = await response.json();
    // Entities and envelopes are components referenced from the routes.
    expect(document.components.schemas.CommandEnvelope.oneOf).toHaveLength(17);
    expect(
      document.paths['/api/commands'].post.requestBody.content[
        'application/json'
      ].schema.$ref,
    ).toBe('#/components/schemas/CommandEnvelope');
    expect(document.components.schemas.Task.properties.title).toBeDefined();
    expect(
      document.components.schemas.Task.properties.ownerTouchedAt,
    ).toBeDefined();
    expect(
      JSON.stringify(document.paths['/api/tasks/{id}'].get.responses['200']),
    ).toContain('#/components/schemas/Task');
    expect(JSON.stringify(document.paths['/api/snapshot'])).toContain(
      '#/components/schemas/Snapshot',
    );
  });
});
describe('desk order (plan 13)', () => {
  const focused = (f: ReturnType<typeof setup>) =>
    f
      .state()
      .tasks.filter((t) => t.focus)
      .sort((a, b) => (a.focusKey! < b.focusKey! ? -1 : 1))
      .map((t) => t.id);
  const revision = (f: ReturnType<typeof setup>, id: string) =>
    f.state().tasks.find((t) => t.id === id)!.revision;
  it('focus without a position goes last; first, after and before place a task on the desk', async () => {
    const f = setup();
    for (const id of ['a', 'b', 'c', 'd'])
      await f.post({
        command: 'task.create',
        payload: { id, area: 'agency', title: id },
      });
    for (const id of ['a', 'b'])
      success(
        await f.post({
          command: 'task.update',
          payload: { id, baseRevision: revision(f, id), focus: true },
        }),
      );
    expect(focused(f)).toEqual(['a', 'b']);
    success(
      await f.post({
        command: 'task.update',
        payload: {
          id: 'c',
          baseRevision: revision(f, 'c'),
          focusPosition: { first: true },
        },
      }),
    );
    expect(focused(f)).toEqual(['c', 'a', 'b']);
    success(
      await f.post({
        command: 'task.save',
        payload: {
          id: 'd',
          baseRevision: revision(f, 'd'),
          fields: { focusPosition: { after: 'c' } },
        },
      }),
    );
    expect(focused(f)).toEqual(['c', 'd', 'a', 'b']);
    // Moving a task already on the desk keeps focus and changes only the key.
    success(
      await f.post({
        command: 'task.update',
        payload: {
          id: 'b',
          baseRevision: revision(f, 'b'),
          focusPosition: { before: 'c' },
        },
      }),
    );
    expect(focused(f)).toEqual(['b', 'c', 'd', 'a']);
    const state = f.state();
    for (const t of state.tasks) {
      expect(t.focus).toBe(t.focusKey !== null);
      expect(t.focusLeftAt).toBeNull();
    }
    // A neighbour outside the desk is invalid; a position with focus: false
    // contradicts itself.
    const outside = await f.post({
      command: 'task.create',
      payload: { id: 'e', area: 'agency', title: 'e' },
    });
    success(outside);
    expect(
      (
        await f.post({
          command: 'task.update',
          payload: {
            id: 'a',
            baseRevision: revision(f, 'a'),
            focusPosition: { after: 'e' },
          },
        })
      ).body,
    ).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      (
        await f.post({
          command: 'task.update',
          payload: {
            id: 'a',
            baseRevision: revision(f, 'a'),
            focus: false,
            focusPosition: { first: true },
          },
        })
      ).body,
    ).toMatchObject({ ok: false, code: 'invalid' });
    // Leaving the desk records the moment; returning clears it.
    success(
      await f.post({
        command: 'task.update',
        payload: { id: 'a', baseRevision: revision(f, 'a'), focus: false },
      }),
    );
    const a = f.state().tasks.find((t) => t.id === 'a')!;
    expect(a).toMatchObject({
      focus: false,
      focusKey: null,
      focusLeftAt: '2026-09-08T12:00:00.000Z',
    });
    expect(focused(f)).toEqual(['b', 'c', 'd']);
    success(
      await f.post({
        command: 'task.create',
        payload: { id: 'f', area: 'agency', title: 'f', focus: true },
      }),
    );
    expect(focused(f)).toEqual(['b', 'c', 'd', 'f']);
  });
  it('done and archive leave the desk with focusLeftAt; undo restores focus and the key', async () => {
    const f = setup();
    for (const id of ['a', 'b'])
      await f.post({
        command: 'task.create',
        payload: { id, area: 'agency', title: id, focus: true },
      });
    const key = f.state().tasks.find((t) => t.id === 'a')!.focusKey;
    expect(key).not.toBeNull();
    success(
      await f.post(
        {
          command: 'task.move',
          payload: { id: 'a', baseRevision: revision(f, 'a'), status: 'done' },
        },
        { id: 'done' },
      ),
    );
    expect(f.state().tasks.find((t) => t.id === 'a')).toMatchObject({
      status: 'done',
      focus: false,
      focusKey: null,
      focusLeftAt: '2026-09-08T12:00:00.000Z',
    });
    const undone = success(
      await f.post({ command: 'undo', payload: { operationId: 'done' } }),
    );
    expect(undone.results[0]!.changes).toMatchObject({
      focus: { from: false, to: true },
      focusKey: { from: null, to: key },
      focusLeftAt: { from: '2026-09-08T12:00:00.000Z', to: null },
    });
    expect(f.state().tasks.find((t) => t.id === 'a')).toMatchObject({
      status: 'todo',
      focus: true,
      focusKey: key,
      focusLeftAt: null,
    });
    expect(focused(f)).toEqual(['a', 'b']);
    success(
      await f.post({
        command: 'task.archive',
        payload: { id: 'b', baseRevision: revision(f, 'b') },
      }),
    );
    expect(f.state().tasks.find((t) => t.id === 'b')).toMatchObject({
      archived: true,
      focus: false,
      focusKey: null,
    });
    // task.save with status done leaves the desk the same way.
    success(
      await f.post({
        command: 'task.save',
        payload: { id: 'a', baseRevision: revision(f, 'a'), status: 'done' },
      }),
    );
    expect(f.state().tasks.find((t) => t.id === 'a')!.focus).toBe(false);
    expect(focused(f)).toEqual([]);
  });
});
