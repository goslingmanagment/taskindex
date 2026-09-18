import { afterEach, describe, expect, it } from 'vitest';
import { fixture, success } from './helpers.js';
import type { OperationError, Step, Task } from '../../src/shared/model.js';
import { LIMITS } from '../../src/shared/limits.js';
// TI-095 (owner decision 2026-09-18): steps are records of their own. The
// task shows them as `checklist`, a projection of the live steps in order;
// every step change is an event of entity kind `step` with the task's id.
const cleanup: (() => void)[] = [];
function setup() {
  const f = fixture();
  cleanup.push(f.close);
  return f;
}
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
const task = (f: ReturnType<typeof setup>, id: string): Task =>
  f.state().tasks.find((t) => t.id === id)!;
const step = (f: ReturnType<typeof setup>, id: string): Step =>
  f.state().steps.find((s) => s.id === id)!;
const ids = (t: Task) => t.checklist.map((item) => item.id);
async function planned(f: ReturnType<typeof setup>) {
  success(
    await f.post(
      {
        command: 'task.create',
        payload: {
          id: 't',
          area: 'development',
          title: 'Перенести бота',
          priority: 'p1',
          labels: ['lora'],
          checklist: [
            { id: 's1', text: 'Поднять контейнер' },
            { id: 's2', text: 'Перенести базу', done: true },
            { id: 's3', text: 'Проверить мониторинг' },
          ],
        },
      },
      { id: 'plan' },
    ),
  );
  return f;
}
describe('steps as records', () => {
  it('task.create with a checklist writes step records after the task, credited to the creator', async () => {
    const f = await planned(setup());
    const t = task(f, 't');
    expect(ids(t)).toEqual(['s1', 's2', 's3']);
    expect(t.revision).toBe(1);
    expect(f.state().steps.map((s) => [s.id, s.orderKey, s.revision])).toEqual([
      ['s1', 'a0', 1],
      ['s2', 'a1', 1],
      ['s3', 'a2', 1],
    ]);
    // A step created done is credited to whoever created it.
    expect(step(f, 's2')).toMatchObject({
      done: true,
      doneAt: '2026-09-08T12:00:00.000Z',
      doneBy: 'owner',
      doneByLabel: 'Владелец',
      createdBy: 'owner',
    });
    expect(step(f, 's1')).toMatchObject({ doneAt: null, doneBy: null });
    const stored = await f.app.request('/api/operations/plan');
    const body = (await stored.json()) as {
      result: {
        events: { entityKind: string; entityId: string; taskId?: string }[];
      };
    };
    expect(
      body.result.events.map((e) => [e.entityKind, e.entityId, e.taskId]),
    ).toEqual([
      ['task', 't', undefined],
      ['step', 's1', 't'],
      ['step', 's2', 't'],
      ['step', 's3', 't'],
    ]);
    // The projection carries what readers need and nothing of the record's
    // bookkeeping.
    expect(t.checklist[1]).toEqual({
      id: 's2',
      text: 'Перенести базу',
      done: true,
      doneAt: '2026-09-08T12:00:00.000Z',
      doneBy: 'owner',
      doneByLabel: 'Владелец',
      result: '',
      linkedTaskId: null,
      revision: 1,
    });
  });
  it('adds at a position, moves, reorders and removes softly; undo of a removal brings the step back', async () => {
    const f = await planned(setup());
    success(
      await f.post({
        command: 'checklist.add',
        payload: { taskId: 't', id: 's4', text: 'Между', position: 1 },
      }),
    );
    expect(ids(task(f, 't'))).toEqual(['s1', 's4', 's2', 's3']);
    expect(task(f, 't').revision).toBe(1);
    success(
      await f.post({
        command: 'checklist.move',
        payload: {
          taskId: 't',
          itemId: 's4',
          baseRevision: step(f, 's4').revision,
          after: 's3',
        },
      }),
    );
    expect(ids(task(f, 't'))).toEqual(['s1', 's2', 's3', 's4']);
    const reordered = success(
      await f.post({
        command: 'checklist.reorder',
        payload: { taskId: 't', itemIds: ['s4', 's3', 's2', 's1'] },
      }),
    );
    expect(ids(task(f, 't'))).toEqual(['s4', 's3', 's2', 's1']);
    expect(reordered.results[0]!.record).toMatchObject({ id: 't' });
    expect(reordered.results[0]!.records).toHaveLength(4);
    const removed = success(
      await f.post(
        {
          command: 'checklist.remove',
          payload: {
            taskId: 't',
            itemId: 's2',
            baseRevision: step(f, 's2').revision,
          },
        },
        { id: 'remove-s2' },
      ),
    );
    expect(ids(task(f, 't'))).toEqual(['s4', 's3', 's1']);
    expect(step(f, 's2').removedAt).toBe('2026-09-08T12:00:00.000Z');
    expect(removed.results[0]!.record).toMatchObject({ id: 's2' });
    // A removed step is not addressable, its id stays taken.
    const again = await f.post({
      command: 'checklist.update',
      payload: { taskId: 't', itemId: 's2', baseRevision: 2, done: true },
    });
    expect(again.status).toBe(404);
    expect((again.body as OperationError).message).toBe('Шаг удалён.');
    const reuse = await f.post({
      command: 'checklist.add',
      payload: { taskId: 't', id: 's2', text: 'Снова' },
    });
    expect(reuse.status).toBe(409);
    success(
      await f.post({
        command: 'undo',
        payload: { operationId: 'remove-s2' },
      }),
    );
    expect(ids(task(f, 't'))).toEqual(['s4', 's3', 's2', 's1']);
    // Created, moved by the reorder, removed, restored.
    expect(step(f, 's2')).toMatchObject({ removedAt: null, revision: 4 });
  });
  it('ticking stamps who and when, unticking clears it; result and text are kept per step', async () => {
    const f = await planned(setup());
    const ticked = success(
      await f.post(
        {
          command: 'checklist.update',
          payload: {
            taskId: 't',
            itemId: 's1',
            baseRevision: 1,
            done: true,
            result: 'PR #12, тесты зелёные',
          },
        },
        { role: 'agent' },
      ),
    );
    expect(ticked.results[0]!.record).toMatchObject({
      id: 's1',
      done: true,
      doneBy: 'agent:test-agent',
      doneByLabel: 'Тестовый агент',
      doneAt: '2026-09-08T12:00:00.000Z',
      result: 'PR #12, тесты зелёные',
      revision: 2,
    });
    expect(Object.keys(ticked.results[0]!.changes).toSorted()).toEqual([
      'done',
      'doneAt',
      'doneBy',
      'doneByLabel',
      'result',
    ]);
    success(
      await f.post({
        command: 'checklist.update',
        payload: { taskId: 't', itemId: 's1', baseRevision: 2, done: false },
      }),
    );
    expect(step(f, 's1')).toMatchObject({
      done: false,
      doneAt: null,
      doneBy: null,
      doneByLabel: null,
      result: 'PR #12, тесты зелёные',
    });
    // The step's own revision is the base: a stale one conflicts on the
    // fields that overlap, the task's revision is not involved.
    const stale = await f.post({
      command: 'checklist.update',
      payload: { taskId: 't', itemId: 's1', baseRevision: 1, text: 'Другой' },
    });
    expect(stale.status).toBe(200);
    const overlap = await f.post({
      command: 'checklist.update',
      payload: { taskId: 't', itemId: 's1', baseRevision: 2, done: true },
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body).toMatchObject({
      conflicts: [{ entityKind: 'step', entityId: 's1', fields: ['done'] }],
    });
    expect(task(f, 't').revision).toBe(1);
  });
  it('promote grows a step into a task of the same area, direction, priority and labels, links them in one operation, and undo takes both back', async () => {
    const f = await planned(setup());
    success(
      await f.post({
        command: 'project.create',
        payload: {
          id: 'bots',
          area: 'development',
          name: 'Боты',
          color: '#112233',
        },
      }),
    );
    success(
      await f.post({
        command: 'task.update',
        payload: { id: 't', baseRevision: 1, projectId: 'bots' },
      }),
    );
    const promoted = success(
      await f.post(
        {
          command: 'checklist.promote',
          payload: {
            taskId: 't',
            itemId: 's3',
            baseRevision: 1,
            id: 'monitoring',
          },
        },
        { id: 'promote', role: 'tasks' },
      ),
    );
    const child = task(f, 'monitoring');
    expect(child).toMatchObject({
      area: 'development',
      projectId: 'bots',
      title: 'Проверить мониторинг',
      priority: 'p1',
      labels: ['lora'],
      status: 'todo',
      createdBy: 'agent:test-agent',
    });
    expect(child.note).toContain('Перенести бота');
    expect(child.note).toContain('(t)');
    expect(step(f, 's3').linkedTaskId).toBe('monitoring');
    expect(task(f, 't').checklist[2]!.linkedTaskId).toBe('monitoring');
    expect(promoted.results[0]!.record).toMatchObject({ id: 'monitoring' });
    expect(promoted.results[0]!.records!.map((r) => r.id)).toEqual([
      'monitoring',
      's3',
    ]);
    expect(
      promoted.events.map((e) => [e.entityKind, e.entityId, e.command]),
    ).toEqual([
      ['task', 'monitoring', 'checklist.promote'],
      ['step', 's3', 'checklist.promote'],
    ]);
    const twice = await f.post({
      command: 'checklist.promote',
      payload: { taskId: 't', itemId: 's3', baseRevision: 2 },
    });
    expect(twice.status).toBe(400);
    expect((twice.body as OperationError).message).toBe(
      'Шаг уже вынесен в задачу.',
    );
    // A title and direction of one's own, the parent's priority otherwise.
    success(
      await f.post({
        command: 'checklist.promote',
        payload: {
          taskId: 't',
          itemId: 's1',
          baseRevision: 1,
          title: 'Контейнер на новом сервере',
          projectId: null,
          priority: 'p3',
        },
      }),
    );
    const other = f
      .state()
      .tasks.find((x) => x.id === step(f, 's1').linkedTaskId)!;
    expect(other).toMatchObject({
      title: 'Контейнер на новом сервере',
      projectId: null,
      priority: 'p3',
    });
    // Undo of a promotion archives the created task and drops the link.
    success(
      await f.post({ command: 'undo', payload: { operationId: 'promote' } }),
    );
    expect(task(f, 'monitoring').archived).toBe(true);
    expect(step(f, 's3').linkedTaskId).toBeNull();
    // A link to a task that does not exist, or to the step's own task, is
    // refused.
    for (const linkedTaskId of ['nowhere', 't']) {
      const refused = await f.post({
        command: 'checklist.update',
        payload: {
          taskId: 't',
          itemId: 's2',
          baseRevision: step(f, 's2').revision,
          linkedTaskId,
        },
      });
      expect(refused.status).toBe(linkedTaskId === 't' ? 400 : 404);
    }
  });
  it('task.save changes the listed steps only: patches by their revision, removes what is flagged, places new ones after their neighbour and orders the listed ones', async () => {
    const f = await planned(setup());
    // Another party adds a step the client has not seen.
    success(
      await f.post(
        {
          command: 'checklist.add',
          payload: { taskId: 't', id: 'agent-step', text: 'Агентский' },
        },
        { role: 'agent' },
      ),
    );
    const saved = success(
      await f.post({
        command: 'task.save',
        payload: {
          id: 't',
          baseRevision: 1,
          fields: { note: 'План уточнён' },
          checklist: [
            {
              id: 's3',
              text: 'Проверить мониторинг',
              done: false,
              revision: 1,
            },
            { id: 'new', text: 'Новый после третьего' },
            { id: 's1', text: 'Поднять контейнер (докер)', revision: 1 },
            { id: 's2', text: 'Перенести базу', removed: true },
          ],
        },
      }),
    );
    // Listed steps in the order given, the unseen one untouched in place.
    expect(ids(task(f, 't'))).toEqual(['s3', 'new', 's1', 'agent-step']);
    expect(step(f, 's1').text).toBe('Поднять контейнер (докер)');
    expect(step(f, 's2').removedAt).not.toBeNull();
    expect(step(f, 'agent-step').revision).toBe(1);
    expect(task(f, 't')).toMatchObject({ note: 'План уточнён', revision: 2 });
    expect(saved.results[0]!.record).toMatchObject({ id: 't' });
    expect(saved.results[0]!.records!.map((r) => r.id)).toContain('new');
    // A stale step revision conflicts on the step, nothing is saved.
    const stale = await f.post({
      command: 'task.save',
      payload: {
        id: 't',
        baseRevision: 2,
        fields: { note: 'Не записывать' },
        checklist: [{ id: 's1', text: 'Снова другой', revision: 1 }],
      },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      conflicts: [{ entityKind: 'step', entityId: 's1', fields: ['text'] }],
    });
    expect(task(f, 't').note).toBe('План уточнён');
    // Without a revision the current one is the base; an unchanged list is
    // a no-op that leaves every revision alone.
    const same = success(
      await f.post({
        command: 'task.save',
        payload: {
          id: 't',
          baseRevision: 2,
          checklist: task(f, 't').checklist.map((i) => ({
            id: i.id,
            text: i.text,
            done: i.done,
          })),
        },
      }),
    );
    expect(same.events).toEqual([]);
  });
  it('task.sync writes steps only when it creates the task and skips them afterwards as locked', async () => {
    const f = setup();
    const origin = { system: 'tg', ref: 'chat:1', version: '1' };
    success(
      await f.post(
        {
          command: 'task.sync',
          payload: {
            origin,
            fields: {
              area: 'agency',
              title: 'Из источника',
              checklist: [{ id: 'src-1', text: 'Шаг источника' }],
            },
          },
        },
        { role: 'agent' },
      ),
    );
    const created = f.state().tasks[0]!;
    expect(ids(created)).toEqual(['src-1']);
    expect(step(f, 'src-1').createdBy).toBe('agent:test-agent');
    const again = success(
      await f.post(
        {
          command: 'task.sync',
          payload: {
            origin: { ...origin, version: '2' },
            fields: {
              area: 'agency',
              title: 'Из источника',
              checklist: [{ id: 'src-2', text: 'Другой шаг' }],
            },
          },
        },
        { role: 'agent' },
      ),
    );
    expect(again.results[0]!.skipped).toEqual([
      { field: 'checklist', reason: 'locked' },
    ]);
    expect(ids(f.state().tasks[0]!)).toEqual(['src-1']);
  });
  it('keeps the limit on live steps, the read scope out and steps in the snapshot and export', async () => {
    const f = await planned(setup());
    for (let n = 3; n < LIMITS.checklistItems; n++)
      success(
        await f.post({
          command: 'checklist.add',
          payload: { taskId: 't', id: `fill-${n}`, text: `Шаг ${n}` },
        }),
      );
    const over = await f.post({
      command: 'checklist.add',
      payload: { taskId: 't', text: 'Лишний' },
    });
    expect(over.status).toBe(400);
    // A removed step frees its place.
    success(
      await f.post({
        command: 'checklist.remove',
        payload: { taskId: 't', itemId: 's1', baseRevision: 1 },
      }),
    );
    expect(
      (
        await f.post({
          command: 'checklist.add',
          payload: { taskId: 't', text: 'На место убранного' },
        })
      ).status,
    ).toBe(200);
    const read = await f.post(
      {
        command: 'checklist.update',
        payload: { taskId: 't', itemId: 's2', baseRevision: 1, done: false },
      },
      { role: 'read' },
    );
    expect(read.status).toBe(403);
    const snapshot = (await (await f.app.request('/api/snapshot')).json()) as {
      steps: Step[];
      tasks: Task[];
    };
    expect(snapshot.steps).toHaveLength(LIMITS.checklistItems + 1);
    expect(snapshot.tasks[0]!.checklist).toHaveLength(LIMITS.checklistItems);
  });
});
