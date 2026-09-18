import { afterEach, it, expect } from 'vitest';
import { fixture, success } from './helpers.js';
import {
  exportWorkspace,
  importWorkspace,
  createAgent,
} from '../../src/server/admin.js';
import { generation, latestSeq } from '../../src/server/db.js';
import type {
  ExportData,
  Page,
  OperationSummary,
  OperationError,
} from '../../src/shared/model.js';
const cleanup: (() => void)[] = [];
function setup() {
  const f = fixture();
  cleanup.push(f.close);
  return f;
}
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
it('reports every conflicting Undo record and rejects repeated creation undo as conflict', async () => {
  const f = setup();
  await f.batch(
    ['a', 'b'].map((id) => ({
      command: 'task.create' as const,
      payload: { id, area: 'agency' as const, title: id },
    })),
    { id: 'create' },
  );
  await f.batch(
    ['a', 'b'].map((id) => ({
      command: 'task.update' as const,
      payload: { id, baseRevision: 1, title: `new ${id}` },
    })),
    { id: 'edit' },
  );
  await f.batch(
    ['a', 'b'].map((id) => ({
      command: 'task.update' as const,
      payload: { id, baseRevision: 2, title: `later ${id}` },
    })),
  );
  const rejected = await f.post({
    command: 'undo',
    payload: { operationId: 'edit' },
  });
  expect(rejected.status).toBe(409);
  expect((rejected.body as OperationError).conflicts).toEqual(
    ['a', 'b'].map((entityId) => ({
      entityKind: 'task',
      entityId,
      fields: ['title'],
    })),
  );
  const other = setup();
  await other.post(
    {
      command: 'task.create',
      payload: { id: 'c', area: 'agency', title: 'C' },
    },
    { id: 'create-c' },
  );
  success(
    await other.post({ command: 'undo', payload: { operationId: 'create-c' } }),
  );
  expect(
    (
      await other.post({
        command: 'undo',
        payload: { operationId: 'create-c' },
      })
    ).body,
  ).toMatchObject({
    code: 'conflict',
    conflicts: [{ entityId: 'c', fields: ['archived'] }],
  });
});
it('operation pages continue after no-event writes without duplicates and include comment task titles once', async () => {
  const f = setup();
  await f.post(
    {
      command: 'task.create',
      payload: { id: 't', area: 'agency', title: 'Task' },
    },
    { id: 'create' },
  );
  await f.post(
    {
      command: 'comment.add',
      payload: { id: 'c', taskId: 't', text: 'Report' },
    },
    { id: 'comment' },
  );
  await f.batch(
    [
      {
        command: 'comment.add',
        payload: { id: 'c2', taskId: 't', text: 'Report 2' },
      },
      {
        command: 'task.update',
        payload: { id: 't', baseRevision: 1, note: 'Note' },
      },
    ],
    { id: 'mixed' },
  );
  const first = (await (
    await f.app.request('/api/operations?limit=1')
  ).json()) as Page<OperationSummary>;
  expect(first.more).toBe(true);
  expect(first.items.map((o) => o.id)).toEqual(['mixed']);
  for (const id of ['comment', 'mixed'])
    expect(
      await (await f.app.request(`/api/operations/${id}`)).json(),
    ).toMatchObject({ taskCount: 1, titles: ['Task'] });
  // A write without events between the pages: the second page answers 200
  // and continues from the position of the first, so the walk shows every
  // operation of the first page's moment once; the new one is ahead of it.
  const seq = latestSeq(f.db);
  success(
    await f.post(
      {
        command: 'task.update',
        payload: { id: 't', baseRevision: 2, note: 'Note' },
      },
      { id: 'no-op' },
    ),
  );
  expect(latestSeq(f.db)).toBe(seq);
  const walked = [...first.items];
  let cursor = first.nextCursor;
  while (cursor) {
    const response = await f.app.request(
      `/api/operations?limit=1&cursor=${cursor}`,
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as Page<OperationSummary>;
    walked.push(...page.items);
    cursor = page.nextCursor;
  }
  expect(walked.map((o) => o.id)).toEqual(['mixed', 'comment', 'create']);
  const full = (await (
    await f.app.request('/api/operations?limit=100')
  ).json()) as Page<OperationSummary>;
  expect(full.items.map((o) => o.id)).toEqual([
    'no-op',
    'mixed',
    'comment',
    'create',
  ]);
});
it('digest cursor links continue the same frozen lists and OpenAPI describes all read endpoints', async () => {
  const f = setup();
  await f.batch(
    Array.from({ length: 55 }, (_, i) => ({
      command: 'task.create' as const,
      payload: {
        id: `t-${i}`,
        area: 'agency' as const,
        title: `T${i}`,
        status: 'waiting' as const,
        followUp: '2026-09-09',
        focus: true,
      },
    })),
  );
  const digest = await (await f.app.request('/api/digest')).json();
  for (const section of [digest.focus[0], digest.waiting]) {
    expect(section.more).toBe(true);
    const response = await f.app.request(
      `${section.href}&cursor=${section.nextCursor}`,
    );
    expect(response.status).toBe(200);
    const next = await response.json();
    expect(next.items).toHaveLength(5);
  }
  const doc = await (await f.app.request('/api/openapi.json')).json();
  for (const path of [
    '/api/context',
    '/api/digest',
    '/api/focus',
    '/api/events/stream',
  ])
    expect(doc.paths[path].get.responses[200]).toBeDefined();
});
it('validates all redundant backup data and history before replacing any existing data', async () => {
  const source = setup();
  await source.post({
    command: 'task.create',
    payload: {
      id: 't',
      area: 'agency',
      title: 'T',
      checklist: [{ id: 'item', text: 'Step', done: false }],
    },
  });
  await source.post({
    command: 'comment.add',
    payload: { id: 'c', taskId: 't', text: 'C' },
  });
  const backup = exportWorkspace(source.db);
  const destination = setup();
  await destination.post({
    command: 'task.create',
    payload: { id: 'keep', area: 'personal', title: 'Keep' },
  });
  const original = exportWorkspace(destination.db);
  const corruptions: ((x: ExportData) => void)[] = [
    (x) => {
      x.steps[0]!.text = 'different';
    },
    (x) => {
      x.seq++;
    },
    (x) => {
      x.operations[0]!.ok = !x.operations[0]!.ok;
    },
    (x) => {
      x.events[0]!.lastSeq = 9;
    },
    (x) => {
      x.operations.find((o) => o.id === x.events[0]!.operationId)!.lastSeq = 9;
    },
    (x) => {
      x.events[0]!.operationId = 'missing';
    },
    (x) => {
      x.tasks[0]!.title = 'Unlogged';
    },
    (x) => {
      x.comments[0]!.taskId = 'missing';
    },
    (x) => {
      x.events[0]!.changes.title!.from = 'Wrong';
    },
    (x) => {
      x.events[0]!.recordRevision = 7;
    },
  ];
  for (const corrupt of corruptions) {
    const damaged = structuredClone(backup);
    corrupt(damaged);
    expect(() =>
      importWorkspace(destination.db, damaged, { replace: true }),
    ).toThrow();
    expect(destination.state().tasks[0]!.id).toBe('keep');
    expect(generation(destination.db)).toBe(original.generation);
  }
  importWorkspace(destination.db, backup, { replace: true });
  expect(destination.state()).toEqual(source.state());
  const restored = exportWorkspace(destination.db);
  importWorkspace(destination.db, restored, { replace: true });
  expect(destination.state()).toEqual(source.state());
});

it('persists valid name swaps and checklist transfers without intermediate uniqueness failures', async () => {
  const f = setup();
  for (const id of ['a', 'b'])
    await f.post({
      command: 'project.create',
      payload: { id, area: 'agency', name: id, color: '#123456' },
    });
  expect(
    (
      await f.batch([
        {
          command: 'project.update',
          payload: { id: 'a', baseRevision: 1, name: 'temporary' },
        },
        {
          command: 'project.update',
          payload: { id: 'b', baseRevision: 1, name: 'a' },
        },
        {
          command: 'project.update',
          payload: { id: 'a', baseRevision: 2, name: 'b' },
        },
      ])
    ).status,
  ).toBe(200);
  expect(f.state().projects.map((p) => [p.id, p.name])).toEqual([
    ['a', 'b'],
    ['b', 'a'],
  ]);
  await f.post({
    command: 'task.create',
    payload: { id: 'a', area: 'agency', title: 'A' },
  });
  await f.post({
    command: 'task.create',
    payload: {
      id: 'b',
      area: 'agency',
      title: 'B',
      checklist: [
        { id: 'first', text: 'First', done: false },
        { id: 'second', text: 'Second', done: false },
      ],
    },
  });
  // 0008: two steps swap places under the unique (task_id, order_key) index
  // while another task gains a step, all in one transaction.
  expect(
    (
      await f.batch([
        {
          command: 'checklist.reorder',
          payload: { taskId: 'b', itemIds: ['second', 'first'] },
        },
        {
          command: 'task.save',
          payload: {
            id: 'a',
            baseRevision: 1,
            checklist: [{ id: 'step', text: 'Step', done: false }],
          },
        },
      ])
    ).status,
  ).toBe(200);
  expect(f.state().tasks.find((t) => t.id === 'a')!.checklist).toHaveLength(1);
  expect(
    f
      .state()
      .tasks.find((t) => t.id === 'b')!
      .checklist.map((item) => item.id),
  ).toEqual(['second', 'first']);
});

it('immediately flushes an SSE connection with an empty backlog', async () => {
  const f = setup();
  const response = await f.app.request(
    `/api/events/stream?generation=${generation(f.db)}&since=0`,
  );
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe(': connected\n\n');
  await reader.cancel();
});

it('SSE invalidates operations for committed rejections and no-ops without advancing the event cursor', async () => {
  const f = setup();
  const gen = generation(f.db);
  const response = await f.app.request(
    `/api/events/stream?generation=${gen}&since=0`,
  );
  const reader = response.body!.getReader();
  const next = async () =>
    new TextDecoder().decode((await reader.read()).value);
  expect(await next()).toBe(': connected\n\n');
  const rejected = {
    command: 'task.update' as const,
    payload: { id: 'missing', baseRevision: 1, title: 'Missing' },
  };
  expect((await f.post(rejected, { id: 'rejected' })).status).toBe(404);
  expect(await next()).toBe(
    `event: operations\ndata: ${JSON.stringify({ generation: gen, operationSeq: 1 })}\n\n`,
  );
  expect(latestSeq(f.db)).toBe(0);
  // Neither replay nor dry run creates another operation notification.
  await f.post(rejected, { id: 'rejected' });
  await f.post(rejected, { id: 'dry-rejection', dryRun: true });
  success(
    await f.post({
      command: 'task.create',
      payload: { id: 't', area: 'agency', title: 'Task' },
    }),
  );
  expect(await next()).toContain(`id: ${gen}:1\n`);
  expect(await next()).toContain('event: operations\n');
  success(
    await f.post({
      command: 'task.update',
      payload: { id: 't', baseRevision: 1, title: 'Task' },
    }),
  );
  expect(latestSeq(f.db)).toBe(1);
  expect(await next()).toContain('event: operations\n');
  await f.batch([rejected], { id: 'batch-rejected' });
  expect(await next()).toContain('event: operations\n');
  expect(latestSeq(f.db)).toBe(1);
  await reader.cancel();
});

it('does not treat agents or terminal operation records as an empty database for import', async () => {
  const empty = setup();
  const backup = exportWorkspace(empty.db);
  const withAgent = setup();
  createAgent(withAgent.db, { id: 'keep', label: 'Keep' });
  expect(() => importWorkspace(withAgent.db, backup)).toThrow();
  expect(withAgent.db.sqlite.prepare('SELECT id FROM agents').get()).toEqual({
    id: 'keep',
  });
  const withOperation = setup();
  await withOperation.post(
    {
      command: 'task.update',
      payload: { id: 'missing', baseRevision: 1, title: 'X' },
    },
    { id: 'failure' },
  );
  expect(() => importWorkspace(withOperation.db, backup)).toThrow();
  const result = await (
    await withOperation.app.request('/api/operations')
  ).json();
  expect(result.items[0]).toMatchObject({
    id: 'failure',
    status: 404,
    ok: false,
    errorCode: 'not_found',
    errorMessage: expect.any(String),
  });
});
it('sync protects an owner-restored source URL while still advancing the source watermark', async () => {
  const f = setup();
  const origin = {
    system: 'hub',
    ref: '1',
    version: '1',
    url: 'https://example.test/a',
  };
  await f.post(
    {
      command: 'task.sync',
      payload: { origin, fields: { area: 'agency', title: 'T' } },
    },
    { role: 'agent' },
  );
  await f.post(
    {
      command: 'task.sync',
      payload: {
        origin: { ...origin, version: '2', url: 'https://example.test/b' },
        fields: { area: 'agency', title: 'T' },
      },
    },
    { role: 'agent', id: 'url-two' },
  );
  success(
    await f.post({ command: 'undo', payload: { operationId: 'url-two' } }),
  );
  const result = success(
    await f.post(
      {
        command: 'task.sync',
        payload: {
          origin: { ...origin, version: '3', url: 'https://example.test/c' },
          fields: { area: 'agency', title: 'T' },
        },
      },
      { role: 'agent' },
    ),
  );
  expect(result.results[0]!.skipped).toContainEqual({
    field: 'originUrl',
    reason: 'owner',
  });
  expect(f.state().tasks[0]).toMatchObject({
    originUrl: origin.url,
    originVersion: '3',
  });
});
// Plan 13, test 2: the desk answered by /api/focus and mirrored in digest.
it('serves the desk: current, next, waiting by follow-up, recent leavers, counts and the groups', async () => {
  const f = setup();
  await f.batch([
    ...['first', 'second', 'third'].map((id) => ({
      command: 'task.create' as const,
      payload: { id, area: 'agency' as const, title: id, focus: true },
    })),
    {
      command: 'task.create',
      payload: {
        id: 'waiting',
        area: 'agency',
        title: 'W',
        status: 'waiting',
        followUp: '2026-09-07',
      },
    },
    {
      command: 'task.create',
      payload: { id: 'left', area: 'agency', title: 'L', focus: true },
    },
    {
      command: 'task.create',
      payload: { id: 'parked', area: 'agency', title: 'P' },
    },
  ]);
  success(
    await f.post({
      command: 'task.update',
      payload: { id: 'left', baseRevision: 1, focus: false },
    }),
  );
  f.db.sqlite
    .prepare(
      "UPDATE tasks SET focus_left_at = '2026-09-05T12:00:00.000Z' WHERE id = 'left'",
    )
    .run();
  const desk = await (await f.app.request('/api/focus')).json();
  expect(desk.current.id).toBe('first');
  expect(desk.next.map((t: { id: string }) => t.id)).toEqual([
    'second',
    'third',
  ]);
  expect(desk.waiting.map((t: { id: string }) => t.id)).toEqual(['waiting']);
  expect(desk.recent.map((t: { id: string }) => t.id)).toEqual(['left']);
  expect(desk.counts).toEqual({ focus: 3, parked: 2, waiting: 1 });
  expect(
    desk.groups.map((g: { id: string; tasks: { id: string }[] }) => [
      g.id,
      g.tasks.length,
    ]),
  ).toEqual([
    ['selected', 3],
    ['new', 0],
    ['due', 0],
    ['follow-ups', 1],
  ]);
  const digest = await (await f.app.request('/api/digest')).json();
  expect(digest.current.id).toBe('first');
  expect(digest.next.map((t: { id: string }) => t.id)).toEqual([
    'second',
    'third',
  ]);
  // The desk reads tasks only: no query scans the event journal (the page
  // seq is one MAX over the primary key).
  const statements: string[] = [];
  const original = f.db.sqlite.prepare.bind(f.db.sqlite);
  f.db.sqlite.prepare = ((sql: string) => {
    statements.push(sql);
    return original(sql);
  }) as typeof f.db.sqlite.prepare;
  await f.app.request('/api/focus');
  expect(
    statements.filter(
      (s) => /from\s+"?events"?/i.test(s) && !/MAX\(seq\)/.test(s),
    ),
  ).toEqual([]);
});
