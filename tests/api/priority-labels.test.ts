// TI-086: priority, labels and closes on a task; hideP3 on the appearance
// preference; the filters, the digest counters and the catalogue in context.
import { afterEach, describe, it, expect } from 'vitest';
import { fixture, success } from './helpers.js';
import { LABELS, PRIORITIES } from '../../src/shared/labels.js';
import type {
  Context,
  Digest,
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
const task = (f: ReturnType<typeof setup>, id: string): Task =>
  f.state().tasks.find((t) => t.id === id)!;
const ids = async (f: ReturnType<typeof setup>, query: string) => {
  const response = await f.app.request(`/api/tasks?${query}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: { id: string }[] };
  return body.items.map((t) => t.id).toSorted();
};
describe('TI-086 task fields', () => {
  it('creates with defaults, accepts explicit values and records them in the event', async () => {
    const f = setup();
    const plain = success(
      await f.post({
        command: 'task.create',
        payload: { id: 'plain', area: 'agency', title: 'Обычная' },
      }),
    );
    expect(plain.results[0]!.record).toMatchObject({
      priority: 'p2',
      labels: [],
      closes: null,
    });
    const urgent = success(
      await f.post({
        command: 'task.create',
        payload: {
          id: 'urgent',
          area: 'agency',
          title: 'Горит',
          priority: 'p1',
          labels: ['dengi', 'lora'],
          closes: 'lora-km-of-vacancy',
        },
      }),
    );
    expect(urgent.results[0]!.record).toMatchObject({
      priority: 'p1',
      labels: ['dengi', 'lora'],
      closes: 'lora-km-of-vacancy',
    });
    expect(urgent.events[0]!.changes).toMatchObject({
      priority: { from: null, to: 'p1' },
      labels: { from: null, to: ['dengi', 'lora'] },
      closes: { from: null, to: 'lora-km-of-vacancy' },
    });
    const updated = success(
      await f.post({
        command: 'task.update',
        payload: {
          id: 'urgent',
          baseRevision: 1,
          priority: 'p3',
          labels: [],
          closes: null,
        },
      }),
    );
    expect(updated.events[0]!.changes).toEqual(
      expect.objectContaining({
        priority: { from: 'p1', to: 'p3' },
        labels: { from: ['dengi', 'lora'], to: [] },
        closes: { from: 'lora-km-of-vacancy', to: null },
      }),
    );
    const undone = success(
      await f.post({
        command: 'undo',
        payload: { operationId: updated.operationId },
      }),
    );
    expect(undone.results[0]!.record).toMatchObject({
      priority: 'p1',
      labels: ['dengi', 'lora'],
      closes: 'lora-km-of-vacancy',
    });
    const saved = success(
      await f.post({
        command: 'task.save',
        payload: {
          id: 'urgent',
          baseRevision: task(f, 'urgent').revision,
          fields: { priority: 'p2', labels: ['lora'] },
          status: 'doing',
        },
      }),
    );
    expect(saved.results[0]!.record).toMatchObject({
      priority: 'p2',
      labels: ['lora'],
      status: 'doing',
    });
  });
  it('stores labels in catalogue order and treats the same set in another order as no change', async () => {
    const f = setup();
    const created = success(
      await f.post({
        command: 'task.create',
        payload: {
          id: 'l',
          area: 'agency',
          title: 'L',
          labels: ['lora', 'dengi'],
        },
      }),
    );
    expect((created.results[0]!.record as Task).labels).toEqual([
      'dengi',
      'lora',
    ]);
    const same = success(
      await f.post({
        command: 'task.update',
        payload: { id: 'l', baseRevision: 1, labels: ['lora', 'dengi'] },
      }),
    );
    expect(same.events).toEqual([]);
    expect(task(f, 'l').revision).toBe(1);
    const sameAgent = success(
      await f.post(
        {
          command: 'task.update',
          payload: { id: 'l', baseRevision: 1, labels: ['lora', 'dengi'] },
        },
        { role: 'agent' },
      ),
    );
    expect(sameAgent.events).toEqual([]);
    expect(sameAgent.results[0]!.confirmedOwnerFields).toBeUndefined();
    const synced = success(
      await f.post(
        {
          command: 'task.sync',
          payload: {
            origin: { system: 'os', ref: 'l-sync', version: '1' },
            fields: { area: 'agency', title: 'S', labels: ['lora', '5-min'] },
          },
        },
        { role: 'agent' },
      ),
    );
    expect((synced.results[0]!.record as Task).labels).toEqual([
      '5-min',
      'lora',
    ]);
  });
  it('keeps manual order when priorities change and keeps priority when a card moves', async () => {
    const f = setup();
    for (const [id, priority] of [
      ['first', 'p3'],
      ['second', 'p1'],
    ] as const)
      success(
        await f.post({
          command: 'task.create',
          payload: { id, area: 'agency', title: id, priority },
        }),
      );
    const originalKey = task(f, 'first').orderKey;
    const readOrder = async () => {
      const response = await f.app.request('/api/tasks');
      expect(response.status).toBe(200);
      return ((await response.json()) as { items: Task[] }).items.map(
        (t) => t.id,
      );
    };
    expect(await readOrder()).toEqual(['first', 'second']);
    success(
      await f.post({
        command: 'task.update',
        payload: { id: 'first', baseRevision: 1, priority: 'p1' },
      }),
    );
    expect(task(f, 'first').orderKey).toBe(originalKey);
    expect(await readOrder()).toEqual(['first', 'second']);
    success(
      await f.post({
        command: 'task.move',
        payload: {
          id: 'second',
          baseRevision: 1,
          status: 'todo',
          before: 'first',
        },
      }),
    );
    expect(await readOrder()).toEqual(['second', 'first']);
    expect(task(f, 'second').priority).toBe('p1');
  });
  it('refuses an unknown label, a duplicate, more than eight and a slug outside the pattern', async () => {
    const f = setup();
    const refuse = async (payload: Record<string, unknown>, path: string) => {
      const r = await f.post({
        command: 'task.create',
        payload: { area: 'agency', title: 'X', ...payload } as never,
      });
      expect(r.status).toBe(400);
      const body = r.body as OperationError;
      expect(body.code).toBe('invalid');
      expect(body.issues!.map((i) => i.path)).toContain(path);
    };
    await refuse({ labels: ['unknown'] }, 'payload.labels[0]');
    await refuse({ labels: ['dengi', 'dengi'] }, 'payload.labels');
    // A retired label is refused like any unknown one.
    await refuse({ labels: ['otvet'] }, 'payload.labels[0]');
    await refuse(
      {
        labels: [
          'dengi',
          '5-min',
          'lora',
          'lily',
          'ari',
          'dengi',
          '5-min',
          'lora',
          'lily',
        ],
      },
      'payload.labels',
    );
    await refuse({ closes: 'Lora KM' }, 'payload.closes');
    await refuse({ priority: 'p4' }, 'payload.priority');
    expect(f.state().tasks).toHaveLength(0);
  });
  it('task.sync applies the fields until the owner touches the task, then skips priority as locked', async () => {
    const f = setup();
    const origin = { system: 'os', ref: 'tasks:1', version: '1' };
    const created = success(
      await f.post(
        {
          command: 'task.sync',
          payload: {
            origin,
            fields: {
              area: 'agency',
              title: 'Из TASKS.md',
              priority: 'p3',
              labels: ['dengi'],
              closes: 'fyp-production-no-contractor',
            },
          },
        },
        { role: 'agent' },
      ),
    );
    expect(created.results[0]).toMatchObject({
      applied: expect.arrayContaining(['priority', 'labels', 'closes']),
    });
    const id = (created.results[0]!.record as Task).id;
    const second = success(
      await f.post(
        {
          command: 'task.sync',
          payload: {
            origin: { ...origin, version: '2' },
            fields: {
              area: 'agency',
              title: 'Из TASKS.md',
              priority: 'p1',
              labels: [],
            },
          },
        },
        { role: 'agent' },
      ),
    );
    expect(second.results[0]).toMatchObject({
      applied: expect.arrayContaining(['priority', 'labels']),
    });
    expect(task(f, id)).toMatchObject({ priority: 'p1', labels: [] });
    // The owner touches the note only: priority is locked anyway, labels are not.
    success(
      await f.post({
        command: 'task.update',
        payload: { id, baseRevision: task(f, id).revision, note: 'Владелец' },
      }),
    );
    const third = success(
      await f.post(
        {
          command: 'task.sync',
          payload: {
            origin: { ...origin, version: '3' },
            fields: {
              area: 'agency',
              title: 'Из TASKS.md',
              priority: 'p3',
              labels: ['ari'],
            },
          },
        },
        { role: 'agent' },
      ),
    );
    expect(third.results[0]).toMatchObject({
      applied: expect.arrayContaining(['labels']),
      skipped: expect.arrayContaining([
        { field: 'priority', reason: 'locked' },
      ]),
    });
    expect(task(f, id)).toMatchObject({ priority: 'p1', labels: ['ari'] });
  });
  it('filters /api/tasks by priority, label and closes, and the cursor identity includes them', async () => {
    const f = setup();
    const create = (id: string, extra: Record<string, unknown>) =>
      f.post({
        command: 'task.create',
        payload: { id, area: 'agency', title: id, ...extra } as never,
      });
    expect(
      (await create('a', { priority: 'p1', labels: ['dengi'] })).status,
    ).toBe(200);
    expect(
      (await create('b', { priority: 'p3', labels: ['dengi', 'lora'] })).status,
    ).toBe(200);
    expect((await create('c', { closes: 'x-1' })).status).toBe(200);
    expect(await ids(f, 'priority=p1')).toEqual(['a']);
    expect(await ids(f, 'priority=p3')).toEqual(['b']);
    expect(await ids(f, 'label=dengi')).toEqual(['a', 'b']);
    expect(await ids(f, 'label=lora&priority=p3')).toEqual(['b']);
    expect(await ids(f, 'closes=x-1')).toEqual(['c']);
    expect((await f.app.request('/api/tasks?label=nope')).status).toBe(400);
    expect((await f.app.request('/api/tasks?priority=p9')).status).toBe(400);
    expect((await f.app.request('/api/tasks?closes=Bad')).status).toBe(400);
    const page = (await (
      await f.app.request('/api/tasks?label=dengi&limit=1')
    ).json()) as { nextCursor: string | null };
    expect(page.nextCursor).not.toBeNull();
    const other = await f.app.request(
      `/api/tasks?label=lora&limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`,
    );
    expect(other.status).toBe(400);
  });
  it('digest counts p1 without done and archived tasks and no retired label; context lists the catalogues', async () => {
    const f = setup();
    const create = (id: string, extra: Record<string, unknown>) =>
      f.post({
        command: 'task.create',
        payload: { id, area: 'agency', title: id, ...extra } as never,
      });
    await create('open', { priority: 'p1', labels: ['dengi'] });
    await create('done', { priority: 'p1', labels: ['dengi'], status: 'done' });
    await create('other', { priority: 'p1', labels: ['dengi'] });
    success(
      await f.post({
        command: 'task.archive',
        payload: { id: 'other', baseRevision: 1 },
      }),
    );
    const digest = (await (
      await f.app.request('/api/digest')
    ).json()) as Digest;
    expect(digest.counts).toMatchObject({ p1: 1 });
    expect(digest.counts).not.toHaveProperty('otvet');
    const context = (await (
      await f.app.request('/api/context')
    ).json()) as Context;
    expect(context.priorities).toEqual([...PRIORITIES]);
    expect(context.labels).toEqual([...LABELS]);
    expect(context.labels.map((label) => label.id)).not.toContain('otvet');
    expect(context.rules.join('\n')).toContain(
      'Порядок карточек в колонке остаётся ручным',
    );
    expect(context.rules.join('\n')).toContain('task.sync не меняет priority');
  });
});
