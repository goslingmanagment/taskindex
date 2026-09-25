import { afterEach, describe, expect, it } from 'vitest';
import { fixture, success } from './helpers.js';
import {
  exportWorkspace,
  importWorkspace,
  validateExport,
} from '../../src/server/admin.js';
import { migrate, openDatabase, readState } from '../../src/server/db.js';
import { FORMAT_VERSION } from '../../src/shared/model.js';
import type {
  Command,
  CommandResult,
  OperationError,
  Proposal,
  Task,
} from '../../src/shared/model.js';
// Agent proposals (spec docs/specs/2026-09-25-agent-proposals.md §8, plan
// 2026-09-25-proposals-phase1 §1): the night shift queues and shows exact
// task commands, an agent accepts or rejects them on the owner's word.
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
function setup(start = '2026-09-25T07:00:00.000Z') {
  const clock = { now: start };
  const f = fixture({ now: () => clock.now });
  cleanup.push(f.close);
  // Every write a second later, so creation order is the queue order.
  const tick = () => {
    clock.now = new Date(Date.parse(clock.now) + 1000).toISOString();
  };
  return { ...f, clock, tick };
}
type Fixture = ReturnType<typeof setup>;
const evidence = [
  { source: 'board', ref: 'task', at: '2026-09-25', quote: 'Стрижка 21.09' },
] as const;
const newTask = (
  fingerprint: string,
  extra: Record<string, unknown> = {},
): Command => ({
  command: 'proposal.create',
  payload: {
    kind: 'new_task',
    command: {
      command: 'task.create',
      payload: { area: 'agency', title: `Задача ${fingerprint}` },
    },
    reason: 'Договорились в чате',
    evidence: [...evidence],
    fingerprint,
    rank: 2,
    ...extra,
  },
});
const change = (
  task: Task,
  command: 'task.update' | 'task.move' | 'task.archive',
  fields: Record<string, unknown>,
  fingerprint: string,
  rank: 1 | 2 | 3 = 3,
): Command => ({
  command: 'proposal.create',
  payload: {
    kind: 'task_change',
    taskId: task.id,
    baseRevision: task.revision,
    command: {
      command,
      payload: { id: task.id, baseRevision: task.revision, ...fields },
    },
    reason: 'Дата в названии прошла',
    evidence: [...evidence],
    fingerprint,
    rank,
  },
});
const task = (f: Fixture, id: string): Task =>
  f.state().tasks.find((t) => t.id === id)!;
const proposal = (f: Fixture, id: string): Proposal =>
  f.state().proposals.find((p) => p.id === id)!;
async function createTask(
  f: Fixture,
  id: string,
  fields: Record<string, unknown> = {},
) {
  success(
    await f.post({
      command: 'task.create',
      payload: { id, area: 'personal', title: `Задача ${id}`, ...fields },
    }),
  );
  return task(f, id);
}
async function propose(
  f: Fixture,
  command: Command,
  id?: string,
): Promise<CommandResult> {
  f.tick();
  return success(
    await f.post(command, { role: 'propose', ...(id ? { id } : {}) }),
  ).results[0]!;
}
async function deliver(f: Fixture, limit?: number): Promise<CommandResult> {
  return success(
    await f.post(
      {
        command: 'proposal.deliver',
        payload: limit === undefined ? {} : { limit },
      },
      { role: 'propose' },
    ),
  ).results[0]!;
}
const accept = (
  f: Fixture,
  ref: string,
  patch?: Record<string, unknown>,
  options: { id?: string; role?: string } = {},
) =>
  f.post(
    {
      command: 'proposal.accept',
      payload: { ref, ...(patch ? { patch } : {}) },
    },
    { role: 'agent', ...options },
  );
const numbers = (result: CommandResult) =>
  result.shown!.map((p) => [p.number, p.id]);
const ids = (body: { items?: Proposal[] }) => body.items!.map((p) => p.id);

describe('proposal.create', () => {
  it('queues a new task and a change of a task; a repeated fingerprint in any status answers the earlier record', async () => {
    const f = setup();
    const visit = await createTask(f, 'visit', { due: '2026-09-21' });
    const created = await propose(f, newTask('fp-new', { id: 'p-new' }));
    expect(created.existing).toBe(false);
    expect(created.proposal).toMatchObject({
      id: 'p-new',
      kind: 'new_task',
      taskId: null,
      baseRevision: null,
      status: 'queued',
      number: null,
      shownOn: null,
      rank: 2,
      createdBy: 'agent:night-shift',
      createdByLabel: 'Ночная смена',
      revision: 1,
    });
    const archived = await propose(
      f,
      change(visit, 'task.archive', {}, 'audit:dated:visit:2026-09-21'),
    );
    expect(archived.proposal).toMatchObject({
      kind: 'task_change',
      taskId: 'visit',
      baseRevision: 1,
      command: {
        command: 'task.archive',
        payload: { id: 'visit', baseRevision: 1 },
      },
    });
    // A proposal is not the task's record: its events stay out of the
    // task's history.
    const history = await f.app.request('/api/tasks/visit/history');
    const events = ((await history.json()) as { items: { command: string }[] })
      .items;
    expect(events.map((e) => e.command)).toEqual(['task.create']);
    const again = await f.post(
      newTask('fp-new', { reason: 'Другая причина' }),
      { role: 'propose' },
    );
    expect(success(again).results[0]).toMatchObject({
      existing: true,
      proposal: { id: 'p-new', reason: 'Договорились в чате' },
    });
    expect(success(again).events).toEqual([]);
    // A refusal holds: the same fingerprint after a rejection is the rejected
    // record, not a new proposal.
    success(
      await f.post(
        { command: 'proposal.reject', payload: { ref: 'p-new' } },
        { role: 'agent' },
      ),
    );
    const repeated = await propose(f, newTask('fp-new'));
    expect(repeated).toMatchObject({
      existing: true,
      proposal: { id: 'p-new', status: 'rejected' },
    });
    expect(f.state().proposals).toHaveLength(2);
  });
  it('refuses a proposed command its own schema or the proposal rules reject, and a change of an unknown or archived task', async () => {
    const f = setup();
    const visit = await createTask(f, 'visit');
    const old = await createTask(f, 'old');
    success(
      await f.post({
        command: 'task.archive',
        payload: { id: 'old', baseRevision: old.revision },
      }),
    );
    const refused = async (command: Command, path: string) => {
      const response = await f.post(command, { role: 'propose' });
      expect(response.status).toBe(400);
      expect(
        (response.body as OperationError).issues?.map((i) => i.path),
      ).toContain(path);
    };
    await refused(
      newTask('no-title', {
        command: { command: 'task.create', payload: { area: 'agency' } },
      }),
      'payload.command.payload.title',
    );
    await refused(
      newTask('wrong-command', {
        command: {
          command: 'task.update',
          payload: { id: 'visit', baseRevision: 1 },
        },
      }),
      'payload.command.command',
    );
    await refused(
      newTask('long-note', {
        command: {
          command: 'task.create',
          payload: { area: 'agency', title: 'T', note: 'н'.repeat(301) },
        },
      }),
      'payload.command.payload.note',
    );
    await refused(
      newTask('focus', {
        command: {
          command: 'task.create',
          payload: { area: 'agency', title: 'T', focus: true },
        },
      }),
      'payload.command.payload.focus',
    );
    // What «да» creates is what the morning message shows: a place on the
    // board, a link to an outside source and a step already ticked or
    // reported are not in the card, so a proposal does not carry them.
    for (const [key, value, path] of [
      ['position', { after: 'visit' }, 'payload.command.payload.position'],
      [
        'origin',
        { system: 'os', ref: 'problem-1' },
        'payload.command.payload.origin',
      ],
      [
        'checklist',
        [{ text: 'Собрать цифры' }, { text: 'Отправить', done: true }],
        'payload.command.payload.checklist[1].done',
      ],
      [
        'checklist',
        [{ text: 'Отправить', result: 'Отправлено 24.09' }],
        'payload.command.payload.checklist[0].result',
      ],
    ] as const)
      await refused(
        newTask(`hidden-${path}`, {
          command: {
            command: 'task.create',
            payload: { area: 'agency', title: 'Отправить отчёт', [key]: value },
          },
        }),
        path,
      );
    await refused(newTask('digits', { id: '7' }), 'payload.id');
    await refused(
      change(visit, 'task.move', { status: 'doing' }, 'move-doing'),
      'payload.command.payload.status',
    );
    const mismatch = change(visit, 'task.archive', {}, 'mismatch');
    (mismatch.payload as { taskId: string }).taskId = 'old';
    await refused(mismatch, 'payload.taskId');
    const unknown = await f.post(
      change({ ...visit, id: 'missing' }, 'task.archive', {}, 'audit:missing'),
      { role: 'propose' },
    );
    expect(unknown.status).toBe(404);
    const onArchived = await f.post(
      change(old, 'task.archive', {}, 'audit:old'),
      { role: 'propose' },
    );
    expect(onArchived.status).toBe(400);
    expect((onArchived.body as OperationError).message).toContain('в архиве');
    expect(f.state().proposals).toEqual([]);
  });
});

describe('proposal.deliver', () => {
  it('shows up to the limit by rank, then age, under the smallest free numbers, and repeats the same day without changes', async () => {
    const f = setup();
    for (const [i, rank] of [3, 1, 2, 2, 3, 1, 2].entries())
      await propose(f, newTask(`fp-${i}`, { id: `p${i}`, rank }));
    const first = await deliver(f);
    expect(first.date).toBe('2026-09-25');
    expect(numbers(first)).toEqual([
      [1, 'p1'],
      [2, 'p5'],
      [3, 'p2'],
      [4, 'p3'],
      [5, 'p6'],
    ]);
    expect(first.queued).toBe(2);
    expect(first.shown![0]).toMatchObject({
      status: 'shown',
      shownOn: '2026-09-25',
      command: { command: 'task.create' },
      evidence: [...evidence],
    });
    const repeat = success(
      await f.post(
        { command: 'proposal.deliver', payload: {} },
        { role: 'propose' },
      ),
    );
    expect(repeat.events).toEqual([]);
    expect(repeat.results[0]).toEqual(first);
    // The owner answers the day's batch; a later run the same day still
    // shows nothing new: at most the limit a day.
    success(await accept(f, '2'));
    const later = await deliver(f);
    expect(numbers(later)).toEqual([
      [1, 'p1'],
      [3, 'p2'],
      [4, 'p3'],
      [5, 'p6'],
    ]);
    expect(later.queued).toBe(2);
    // Next day the freed number 2 goes first.
    f.clock.now = '2026-09-26T07:00:00.000Z';
    const next = await deliver(f, 1);
    expect(numbers(next)).toEqual([[2, 'p0']]);
    expect(next.queued).toBe(1);
  });
  it('holds at most 15 shown numbers and expires a shown proposal three days after its day', async () => {
    const f = setup('2026-09-21T07:00:00.000Z');
    for (let i = 0; i < 20; i++)
      await propose(f, newTask(`fp-${i}`, { id: `p${i}` }));
    const days = ['2026-09-21', '2026-09-22', '2026-09-23'];
    for (const [i, day] of days.entries()) {
      f.clock.now = `${day}T07:00:00.000Z`;
      expect(numbers(await deliver(f))).toEqual(
        [1, 2, 3, 4, 5].map((n) => [n + i * 5, `p${n - 1 + i * 5}`]),
      );
    }
    // Day four: every number is held and nothing has expired yet.
    f.clock.now = '2026-09-24T07:00:00.000Z';
    const full = await deliver(f);
    expect(full.shown).toEqual([]);
    expect(full.expired).toEqual([]);
    expect(full.queued).toBe(5);
    // Day five: the first day's five expire and free their numbers.
    f.clock.now = '2026-09-25T07:00:00.000Z';
    const fifth = await deliver(f);
    expect(fifth.expired).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    expect(numbers(fifth)).toEqual(
      [1, 2, 3, 4, 5].map((n) => [n, `p${n + 14}`]),
    );
    expect(proposal(f, 'p0')).toMatchObject({
      status: 'expired',
      number: null,
      shownOn: '2026-09-21',
      decidedBy: 'agent:night-shift',
      decidedAt: '2026-09-25T07:00:00.000Z',
    });
  });
  it('hands the number of a proposal expiring in this delivery to an older one in the same operation', async () => {
    const f = setup('2026-09-21T07:00:00.000Z');
    await propose(f, newTask('older', { id: 'p-older', rank: 3 }));
    await propose(f, newTask('urgent', { id: 'p-urgent', rank: 1 }));
    expect(numbers(await deliver(f, 1))).toEqual([[1, 'p-urgent']]);
    f.clock.now = '2026-09-25T07:00:00.000Z';
    const next = await deliver(f, 1);
    expect(next.expired).toEqual(['p-urgent']);
    expect(numbers(next)).toEqual([[1, 'p-older']]);
    expect(f.state().proposals.map((p) => [p.id, p.status, p.number])).toEqual([
      ['p-older', 'shown', 1],
      ['p-urgent', 'expired', null],
    ]);
  });
  it('withdraws a change whose task changed, was archived or closed, queued or shown, and counts the day in the owner time zone', async () => {
    // 22:30 UTC is already the 26th in Moscow.
    const f = setup('2026-09-25T22:30:00.000Z');
    const edited = await createTask(f, 'edited');
    const archived = await createTask(f, 'archived');
    const closed = await createTask(f, 'closed');
    const kept = await createTask(f, 'kept');
    await propose(f, change(edited, 'task.archive', {}, 'a', 1));
    await propose(f, change(kept, 'task.archive', {}, 'b', 1));
    const shown = await deliver(f, 1);
    expect(shown.date).toBe('2026-09-26');
    expect(shown.shown!.map((p) => p.taskId)).toEqual(['edited']);
    await propose(f, change(archived, 'task.update', { note: 'x' }, 'c', 2));
    await propose(f, change(closed, 'task.move', { status: 'done' }, 'd', 2));
    success(
      await f.post({
        command: 'task.update',
        payload: { id: 'edited', baseRevision: 1, note: 'Владелец' },
      }),
    );
    success(
      await f.post({
        command: 'task.archive',
        payload: { id: 'archived', baseRevision: 1 },
      }),
    );
    success(
      await f.post({
        command: 'task.move',
        payload: { id: 'closed', baseRevision: 1, status: 'done' },
      }),
    );
    f.clock.now = '2026-09-26T22:30:00.000Z';
    const next = await deliver(f);
    expect(next.date).toBe('2026-09-27');
    const staleIds = next.stale!;
    expect(
      staleIds.map((id) => [
        f.state().proposals.find((p) => p.id === id)!.taskId,
        f.state().proposals.find((p) => p.id === id)!.decisionReason,
      ]),
    ).toEqual([
      ['edited', 'задача изменилась после предложения'],
      ['archived', 'задача в архиве'],
      ['closed', 'задача уже закрыта'],
    ]);
    // The withdrawn shown proposal freed number 1 for the one still valid.
    expect(next.shown!.map((p) => [p.number, p.taskId])).toEqual([[1, 'kept']]);
  });
});

describe('proposal.accept', () => {
  async function shownFour(f: Fixture) {
    const due = await createTask(f, 'due', { due: '2026-09-20' });
    const finish = await createTask(f, 'finish');
    const visit = await createTask(f, 'visit');
    await propose(f, newTask('new', { id: 'p-new', rank: 1 }));
    await propose(
      f,
      change(due, 'task.update', { due: '2026-10-02' }, 'due', 1),
    );
    await propose(
      f,
      change(finish, 'task.move', { status: 'done' }, 'finish', 1),
    );
    await propose(f, change(visit, 'task.archive', {}, 'visit', 1));
    expect(numbers(await deliver(f)).map(([n]) => n)).toEqual([1, 2, 3, 4]);
  }
  it('executes each of the four commands as the accepting agent and records the outcome', async () => {
    const f = setup();
    await shownFour(f);
    const created = success(await accept(f, '1', undefined, { id: 'acc-1' }));
    const result = created.results[0]!;
    expect(result.task).toMatchObject({
      title: 'Задача new',
      area: 'agency',
      createdBy: 'agent:test-agent',
      revision: 1,
    });
    expect(result.proposal).toMatchObject({
      status: 'accepted',
      number: null,
      decidedBy: 'agent:test-agent',
      decidedByLabel: 'Тестовый агент',
      patch: null,
      resultTaskId: result.task!.id,
    });
    expect(created.events.map((e) => [e.entityKind, e.command])).toEqual([
      ['task', 'task.create'],
      ['proposal', 'proposal.accept'],
    ]);
    success(await accept(f, '2'));
    expect(task(f, 'due').due).toBe('2026-10-02');
    success(await accept(f, '3'));
    expect(task(f, 'finish').status).toBe('done');
    success(await accept(f, '4'));
    expect(task(f, 'visit').archived).toBe(true);
    expect(
      f.state().proposals.map((p) => [p.status, p.resultTaskId !== null]),
    ).toEqual([
      ['accepted', true],
      ['accepted', true],
      ['accepted', true],
      ['accepted', true],
    ]);
  });
  it('applies the owner patch one level deep, may turn an archive into a close, and refuses a patch the proposal rules reject', async () => {
    const f = setup();
    await shownFour(f);
    const patched = success(
      await accept(f, '1', { title: 'Ответить на ревью', priority: 'p3' }),
    ).results[0]!;
    expect(patched.task).toMatchObject({
      title: 'Ответить на ревью',
      priority: 'p3',
      area: 'agency',
    });
    expect(patched.proposal!.patch).toEqual({
      title: 'Ответить на ревью',
      priority: 'p3',
    });
    const closed = success(
      await accept(f, '4', { command: 'task.move', status: 'done' }),
    ).results[0]!;
    expect(closed.task).toMatchObject({ status: 'done', archived: false });
    for (const [patch, path] of [
      [{ status: 'doing' }, 'payload.patch.status'],
      [{ focus: true }, 'payload.patch.focus'],
      [{ command: 'task.restore' }, 'payload.patch.command'],
      [{ id: 'visit' }, 'payload.patch.taskId'],
    ] as const) {
      const refused = await accept(f, '3', patch);
      expect(refused.status).toBe(400);
      expect(
        (refused.body as OperationError).issues?.map((i) => i.path),
      ).toContain(path);
    }
    expect(task(f, 'finish').status).toBe('todo');
    expect(f.state().proposals[2]).toMatchObject({
      taskId: 'finish',
      status: 'shown',
      number: 3,
    });
    // The owner's patch of a new task holds to the same card rules.
    await propose(f, newTask('patched-new', { id: 'p-patched', rank: 1 }));
    f.clock.now = '2026-09-26T07:00:00.000Z';
    await deliver(f);
    const placed = await accept(f, 'p-patched', {
      area: 'personal',
      position: { after: 'finish' },
    });
    expect(placed.status).toBe(400);
    expect(
      (placed.body as OperationError).issues?.map((i) => i.path),
    ).toContain('payload.patch.position');
  });
  it('withdraws the proposal as stale, keeps that outcome and leaves the task alone when the task changed after the proposal', async () => {
    const f = setup();
    const visit = await createTask(f, 'visit');
    await propose(f, change(visit, 'task.archive', {}, 'visit', 1));
    await deliver(f);
    success(
      await f.post({
        command: 'task.update',
        payload: { id: 'visit', baseRevision: 1, note: 'Перенесли' },
      }),
    );
    const response = await accept(f, '1', undefined, { id: 'late' });
    expect(response.status).toBe(200);
    const result = success(response).results[0]!;
    expect(result.task).toBeNull();
    expect(result.reason).toBe(
      'Предложение устарело: задача изменилась после предложения. Задача не изменена.',
    );
    expect(task(f, 'visit')).toMatchObject({ archived: false, revision: 2 });
    const stored = f.state().proposals[0]!;
    expect(stored).toMatchObject({
      status: 'stale',
      number: null,
      decisionReason: 'задача изменилась после предложения',
      decidedBy: 'agent:test-agent',
    });
    const again = await accept(f, stored.id);
    expect(again.status).toBe(409);
    expect((again.body as OperationError).message).toBe(
      'Предложение устарело: задача изменилась после него.',
    );
  });
  it("counts the owner's protected fields as confirmed: he answered «да» to this exact change", async () => {
    const f = setup();
    const owned = await createTask(f, 'owned', { priority: 'p2' });
    expect(owned.ownerFields).toContain('priority');
    const direct = await f.post(
      {
        command: 'task.update',
        payload: { id: 'owned', baseRevision: 1, priority: 'p1' },
      },
      { role: 'tasks' },
    );
    expect(direct.status).toBe(403);
    await propose(f, change(owned, 'task.update', { priority: 'p1' }, 'p1'));
    await deliver(f);
    const accepted = success(await accept(f, '1', undefined, { role: 'tasks' }))
      .results[0]!;
    expect(accepted.task!.priority).toBe('p1');
    expect(accepted.confirmedOwnerFields).toEqual(['priority']);
  });
  it('accepts only a shown proposal: a queued one, a free number and a second accept are refused', async () => {
    const f = setup();
    await propose(f, newTask('queued', { id: 'p-queued' }));
    const queued = await accept(f, 'p-queued');
    expect(queued.status).toBe(409);
    expect((queued.body as OperationError).message).toBe(
      'Предложение ещё не показано владельцу.',
    );
    await deliver(f);
    const free = await accept(f, '2');
    expect(free.status).toBe(404);
    expect((free.body as OperationError).message).toBe(
      'Среди показанных нет предложения 2.',
    );
    success(await accept(f, '1'));
    const second = await accept(f, 'p-queued', undefined, { role: 'agent2' });
    expect(second.status).toBe(409);
    expect((second.body as OperationError).message).toBe(
      'Предложение уже принято.',
    );
  });
  it('undo of the accept operation takes back both the task write and the decision; parts, creation and delivery are not undone', async () => {
    const f = setup();
    const visit = await createTask(f, 'visit');
    await propose(f, change(visit, 'task.archive', {}, 'visit', 1));
    await deliver(f);
    const accepted = success(await accept(f, '1', undefined, { id: 'acc' }));
    expect(task(f, 'visit').archived).toBe(true);
    const proposalEvent = accepted.events.find(
      (e) => e.entityKind === 'proposal',
    )!;
    const bySeq = await f.post(
      { command: 'undo', payload: { seq: proposalEvent.seq } },
      { role: 'agent' },
    );
    expect(bySeq.status).toBe(409);
    expect((bySeq.body as OperationError).code).toBe('not_undoable');
    success(
      await f.post(
        { command: 'undo', payload: { operationId: 'acc' } },
        { role: 'agent' },
      ),
    );
    expect(task(f, 'visit').archived).toBe(false);
    expect(f.state().proposals[0]).toMatchObject({
      status: 'shown',
      number: 1,
      decidedAt: null,
      decidedBy: null,
      resultTaskId: null,
    });
    // The undo moved the task past the proposal: the next delivery withdraws
    // it and gives its number to a new one, accepted in turn. A proposal
    // whose number went on cannot come back under it.
    await propose(f, newTask('a', { id: 'p-a' }));
    f.clock.now = '2026-09-26T07:00:00.000Z';
    const second = await deliver(f);
    expect(second.stale).toEqual([f.state().proposals[0]!.id]);
    expect(numbers(second)).toEqual([[1, 'p-a']]);
    success(await accept(f, '1', undefined, { id: 'acc-a' }));
    await propose(f, newTask('b', { id: 'p-b', rank: 1 }), 'create-op');
    f.clock.now = '2026-09-27T07:00:00.000Z';
    success(
      await f.post(
        { command: 'proposal.deliver', payload: {} },
        { role: 'propose', id: 'deliver-op' },
      ),
    );
    expect(proposal(f, 'p-b').number).toBe(1);
    const clash = await f.post(
      { command: 'undo', payload: { operationId: 'acc-a' } },
      { role: 'agent' },
    );
    expect(clash.status).toBe(409);
    expect((clash.body as OperationError).message).toBe(
      'Номер предложения уже занят.',
    );
    for (const operationId of ['create-op', 'deliver-op']) {
      const undo = await f.post({ command: 'undo', payload: { operationId } });
      expect(undo.status).toBe(409);
      expect((undo.body as OperationError).message).toBe(
        'Создание и показ предложений не отменяются.',
      );
    }
  });
  it('refuses to undo the task write of an acceptance on its own: the task and the decision go back only together', async () => {
    const f = setup();
    await propose(
      f,
      newTask('report', {
        id: 'p-report',
        command: {
          command: 'task.create',
          payload: {
            area: 'agency',
            title: 'Отправить отчёт',
            checklist: [{ text: 'Собрать цифры' }],
          },
        },
      }),
    );
    await deliver(f);
    const accepted = success(await accept(f, '1', undefined, { id: 'acc' }));
    const created = accepted.results[0]!.task!;
    expect(accepted.events.map((e) => e.entityKind)).toEqual([
      'task',
      'step',
      'proposal',
    ]);
    // Neither the agent nor the owner takes back one part by its seq: the
    // task write without the decision would leave the proposal «accepted»
    // with nothing behind it.
    for (const event of accepted.events.filter(
      (e) => e.entityKind !== 'proposal',
    ))
      for (const role of ['agent', 'owner']) {
        const bySeq = await f.post(
          { command: 'undo', payload: { seq: event.seq } },
          { role },
        );
        expect(bySeq.status).toBe(409);
        expect(bySeq.body).toMatchObject({
          code: 'not_undoable',
          message:
            'Решение по предложению отменяется только целиком: undo --operation.',
        });
      }
    expect(task(f, created.id).archived).toBe(false);
    expect(proposal(f, 'p-report').status).toBe('accepted');
    const undone = success(
      await f.post(
        { command: 'undo', payload: { operationId: 'acc' } },
        { role: 'agent' },
      ),
    );
    expect(
      undone.results[0]!.records!.map((record) => [
        record.id,
        'archived' in record ? record.archived : undefined,
        'status' in record ? record.status : undefined,
      ]),
    ).toEqual([
      [created.id, true, 'todo'],
      [f.state().steps[0]!.id, undefined, undefined],
      ['p-report', undefined, 'shown'],
    ]);
    expect(f.state().steps[0]!.removedAt).not.toBeNull();
    expect(proposal(f, 'p-report')).toMatchObject({
      status: 'shown',
      number: 1,
      resultTaskId: null,
    });
  });
});

describe('proposal.reject and reads', () => {
  it('rejects a shown or queued proposal with the reason, not a decided one', async () => {
    const f = setup();
    await propose(f, newTask('a', { id: 'p-a' }));
    await propose(f, newTask('b', { id: 'p-b' }));
    await deliver(f, 1);
    const rejected = success(
      await f.post(
        {
          command: 'proposal.reject',
          payload: { ref: '1', reason: 'Это понятно из названия' },
        },
        { role: 'tasks' },
      ),
    ).results[0]!;
    expect(rejected.proposal).toMatchObject({
      id: 'p-a',
      status: 'rejected',
      number: null,
      decisionReason: 'Это понятно из названия',
      decidedBy: 'agent:test-agent',
    });
    success(
      await f.post(
        { command: 'proposal.reject', payload: { ref: 'p-b' } },
        { role: 'agent' },
      ),
    );
    expect(proposal(f, 'p-b')).toMatchObject({
      status: 'rejected',
      decisionReason: null,
      shownOn: null,
    });
    const twice = await f.post(
      { command: 'proposal.reject', payload: { ref: 'p-b' } },
      { role: 'agent' },
    );
    expect(twice.status).toBe(409);
    expect((twice.body as OperationError).message).toBe(
      'Предложение уже отклонено.',
    );
  });
  it('lists proposals by status and creation date and reads one by number or id, for any scope', async () => {
    const f = setup('2026-09-24T07:00:00.000Z');
    await propose(f, newTask('old', { id: 'p-old' }));
    f.clock.now = '2026-09-25T07:00:00.000Z';
    await propose(f, newTask('new', { id: 'p-new' }));
    await deliver(f, 1);
    const read = async (path: string, role = 'propose') => {
      const response = await f.app.request(path, {
        headers: { 'x-test-role': role },
      });
      return {
        status: response.status,
        body: (await response.json()) as {
          items?: Proposal[];
          id?: string;
        },
      };
    };
    expect(ids((await read('/api/proposals')).body)).toEqual([
      'p-old',
      'p-new',
    ]);
    expect(ids((await read('/api/proposals?status=shown')).body)).toEqual([
      'p-old',
    ]);
    expect(
      ids((await read('/api/proposals?status=queued,shown', 'read')).body),
    ).toEqual(['p-old', 'p-new']);
    expect(ids((await read('/api/proposals?since=2026-09-25')).body)).toEqual([
      'p-new',
    ]);
    expect((await read('/api/proposals/1')).body.id).toBe('p-old');
    expect((await read('/api/proposals/p-new', 'tasks')).body.id).toBe('p-new');
    expect((await read('/api/proposals/2')).status).toBe(404);
    expect((await read('/api/proposals?status=done')).status).toBe(400);
  });
});

describe('export with proposals (format 9)', () => {
  it('exports, validates and imports proposals in every status; a proposal the journal does not explain is refused', async () => {
    const f = setup();
    const visit = await createTask(f, 'visit');
    await propose(f, change(visit, 'task.archive', {}, 'visit', 1));
    await propose(f, newTask('new', { rank: 1 }));
    await propose(f, newTask('queued'));
    await deliver(f, 2);
    success(await accept(f, '1', undefined, { id: 'acc' }));
    success(
      await f.post(
        { command: 'proposal.reject', payload: { ref: '2', reason: 'Нет' } },
        { role: 'agent' },
      ),
    );
    success(await f.post({ command: 'undo', payload: { operationId: 'acc' } }));
    const data = exportWorkspace(f.db);
    expect(data.formatVersion).toBe(FORMAT_VERSION);
    expect(data.proposals.map((p) => p.status).toSorted()).toEqual([
      'queued',
      'rejected',
      'shown',
    ]);
    expect(() => validateExport(data)).not.toThrow();
    const target = openDatabase(':memory:');
    cleanup.push(() => target.close());
    migrate(target);
    importWorkspace(target, data);
    expect(readState(target)).toEqual(readState(f.db));
    const tampered = structuredClone(data);
    tampered.proposals[0]!.status = 'accepted';
    expect(() => validateExport(tampered)).toThrow(
      'состояние записей не совпадает с журналом событий',
    );
  });
});
