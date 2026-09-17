// 0007 (owner decision 2026-09-17): labels are the owner's catalogue in the
// workspace. The owner creates, renames, archives and restores them; agents
// read the catalogue and never change it; archiving takes the label off every
// task in the same operation and is undoable.
import { afterEach, describe, it, expect } from 'vitest';
import { fixture, success } from './helpers.js';
import { SEEDED_LABELS } from '../../src/shared/labels.js';
import { LIMITS } from '../../src/shared/limits.js';
import {
  exportWorkspace,
  importWorkspace,
  validateExport,
} from '../../src/server/admin.js';
import { migrate, openDatabase, readState } from '../../src/server/db.js';
import type {
  Context,
  Label,
  OperationError,
  Task,
} from '../../src/shared/model.js';
const cleanup: (() => void)[] = [];
function setup() {
  const f = fixture();
  cleanup.push(f.close);
  return f;
}
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
const label = (f: ReturnType<typeof setup>, id: string): Label =>
  f.state().labels.find((l) => l.id === id)!;
const task = (f: ReturnType<typeof setup>, id: string): Task =>
  f.state().tasks.find((t) => t.id === id)!;
const urgent = {
  name: 'Срочно',
  color: '#BC3C45',
  description: 'Ждёт ответа сегодня',
};
describe('the label catalogue', () => {
  it('starts seeded, is listed by /api/labels and /api/context, and travels in the snapshot', async () => {
    const f = setup();
    expect(f.state().labels).toEqual(SEEDED_LABELS);
    const listed = (await (await f.app.request('/api/labels')).json()) as {
      labels: Label[];
    };
    expect(listed.labels).toEqual(SEEDED_LABELS);
    const context = (await (
      await f.app.request('/api/context')
    ).json()) as Context;
    expect(context.labels.map((l) => l.id)).toEqual(
      SEEDED_LABELS.map((l) => l.id),
    );
    const snapshot = (await (await f.app.request('/api/snapshot')).json()) as {
      labels: Label[];
    };
    expect(snapshot.labels).toEqual(SEEDED_LABELS);
  });
  it('lets the owner create a label with a slug from its name, rename it and see it in context', async () => {
    const f = setup();
    const created = success(
      await f.post(
        { command: 'label.create', payload: urgent },
        { id: 'label-create' },
      ),
    );
    expect(created.results[0]!.record).toMatchObject({
      id: 'srochno',
      name: 'Срочно',
      color: '#bc3c45',
      description: 'Ждёт ответа сегодня',
      position: 6,
      archivedAt: null,
      revision: 1,
    });
    expect(created.events).toHaveLength(1);
    expect(created.events[0]).toMatchObject({
      entityKind: 'label',
      entityId: 'srochno',
      command: 'label.create',
    });
    // The same name again takes the next free slug, but a duplicate active
    // name is a conflict that points at the existing record.
    const again = await f.post({ command: 'label.create', payload: urgent });
    expect(again.status).toBe(409);
    expect((again.body as OperationError).current).toMatchObject({
      id: 'srochno',
    });
    const renamed = success(
      await f.post({
        command: 'label.update',
        payload: { id: 'srochno', baseRevision: 1, name: 'Горит' },
      }),
    );
    expect(renamed.results[0]!.record).toMatchObject({
      id: 'srochno',
      name: 'Горит',
      revision: 2,
    });
    const context = (await (
      await f.app.request('/api/context')
    ).json()) as Context;
    expect(context.labels.at(-1)).toEqual({
      id: 'srochno',
      name: 'Горит',
      color: '#bc3c45',
      description: 'Ждёт ответа сегодня',
    });
    // A task can carry the new label; the set keeps catalogue order.
    const created2 = success(
      await f.post({
        command: 'task.create',
        payload: {
          id: 't',
          area: 'agency',
          title: 'Т',
          labels: ['srochno', 'dengi'],
        },
      }),
    );
    expect((created2.results[0]!.record as Task).labels).toEqual([
      'dengi',
      'srochno',
    ]);
  });
  it('refuses every label command from an agent, even with the write scope', async () => {
    const f = setup();
    for (const [command, payload] of [
      ['label.create', urgent],
      ['label.update', { id: 'dengi', baseRevision: 1, name: 'x' }],
      ['label.archive', { id: 'dengi', baseRevision: 1 }],
      ['label.restore', { id: 'dengi', baseRevision: 1 }],
    ] as const) {
      const r = await f.post({ command, payload } as never, { role: 'agent' });
      expect(r.status, command).toBe(403);
      expect((r.body as OperationError).message).toBe(
        'Метки заводит и меняет только владелец.',
      );
    }
    expect(f.state().labels).toEqual(SEEDED_LABELS);
  });
  it('archives a label off every task in one operation, refuses it afterwards, and restores without putting it back', async () => {
    const f = setup();
    for (const [id, labels] of [
      ['a', ['5-min', 'lora']],
      ['b', ['5-min']],
      ['c', ['dengi']],
    ] as const)
      success(
        await f.post({
          command: 'task.create',
          payload: { id, area: 'agency', title: id, labels: [...labels] },
        }),
      );
    const archived = success(
      await f.post(
        {
          command: 'label.archive',
          payload: { id: '5-min', baseRevision: 1 },
        },
        { id: 'label-archive' },
      ),
    );
    expect(archived.results[0]!.record).toMatchObject({
      id: '5-min',
      archivedAt: '2026-09-08T12:00:00.000Z',
      revision: 2,
    });
    expect(
      archived.events.map((e) => [e.entityKind, e.entityId, e.command]),
    ).toEqual([
      ['label', '5-min', 'label.archive'],
      ['task', 'a', 'label.archive'],
      ['task', 'b', 'label.archive'],
    ]);
    expect(task(f, 'a').labels).toEqual(['lora']);
    expect(task(f, 'b').labels).toEqual([]);
    expect(task(f, 'c').labels).toEqual(['dengi']);
    const context = (await (
      await f.app.request('/api/context')
    ).json()) as Context;
    expect(context.labels.map((l) => l.id)).not.toContain('5-min');
    const refused = await f.post({
      command: 'task.update',
      payload: { id: 'c', baseRevision: 1, labels: ['5-min'] },
    });
    expect(refused.status).toBe(400);
    expect((refused.body as OperationError).message).toBe(
      'Метка «5 мин» в архиве.',
    );
    // Undo of the archive puts the label and the tasks' labels back.
    success(
      await f.post({
        command: 'undo',
        payload: { operationId: 'label-archive' },
      }),
    );
    expect(label(f, '5-min').archivedAt).toBeNull();
    expect(task(f, 'a').labels).toEqual(['5-min', 'lora']);
    expect(task(f, 'b').labels).toEqual(['5-min']);
    // Restore after a plain archive leaves the tasks as they are.
    success(
      await f.post({
        command: 'label.archive',
        payload: { id: '5-min', baseRevision: label(f, '5-min').revision },
      }),
    );
    success(
      await f.post({
        command: 'label.restore',
        payload: { id: '5-min', baseRevision: label(f, '5-min').revision },
      }),
    );
    expect(label(f, '5-min').archivedAt).toBeNull();
    expect(task(f, 'a').labels).toEqual(['lora']);
  });
  it('undoes a creation by archiving the label and caps the active catalogue', async () => {
    const f = setup();
    success(
      await f.post(
        { command: 'label.create', payload: urgent },
        { id: 'label-create' },
      ),
    );
    success(
      await f.post({
        command: 'undo',
        payload: { operationId: 'label-create' },
      }),
    );
    expect(label(f, 'srochno').archivedAt).not.toBeNull();
    // A name freed by the archive can be used again under a new slug.
    const reused = success(
      await f.post({ command: 'label.create', payload: urgent }),
    );
    expect(reused.results[0]!.record).toMatchObject({ id: 'srochno-2' });
    for (
      let n = f.state().labels.filter((l) => !l.archivedAt).length;
      n < LIMITS.labels;
      n++
    )
      success(
        await f.post({
          command: 'label.create',
          payload: { ...urgent, name: `Метка ${n}` },
        }),
      );
    const over = await f.post({
      command: 'label.create',
      payload: { ...urgent, name: 'Лишняя' },
    });
    expect(over.status).toBe(400);
    expect((over.body as OperationError).message).toBe(
      'Слишком много меток: уберите лишние в архив.',
    );
  });
  it('survives export, validation and import with created, renamed and archived labels', async () => {
    const f = setup();
    success(await f.post({ command: 'label.create', payload: urgent }));
    success(
      await f.post({
        command: 'label.update',
        payload: { id: 'dengi', baseRevision: 1, color: '#123456' },
      }),
    );
    success(
      await f.post({
        command: 'task.create',
        payload: { id: 't', area: 'agency', title: 'Т', labels: ['srochno'] },
      }),
    );
    success(
      await f.post({
        command: 'label.archive',
        payload: { id: 'srochno', baseRevision: 1 },
      }),
    );
    const exported = exportWorkspace(f.db);
    expect(exported.labels.map((l) => l.id)).toEqual([
      ...SEEDED_LABELS.map((l) => l.id),
      'srochno',
    ]);
    expect(() => validateExport(exported)).not.toThrow();
    const target = openDatabase(':memory:');
    cleanup.push(() => target.close());
    migrate(target);
    importWorkspace(target, exported);
    expect(readState(target)).toEqual(readState(f.db));
  });
});
