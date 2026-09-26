import { afterEach, describe, it, expect } from 'vitest';
import { fixture, success } from './helpers.js';
import { focusGroups } from '../../src/shared/queries.js';
import type {
  Command,
  OperationError,
  StoredOperation,
  Task,
} from '../../src/shared/model.js';
const cleanup: (() => void)[] = [];
function setup() {
  const f = fixture();
  cleanup.push(f.close);
  return f;
}
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
const snapshot = (f: ReturnType<typeof setup>) => JSON.stringify(f.state());
const FOCUS_ONLY_OWNER = 'Поле focus меняет только владелец.';
const OWNER_DECISION = 'Агент не отменяет операции с событиями владельца.';
const PROTECTED = 'Поле защищено владельцем';
async function seed(f: ReturnType<typeof setup>) {
  success(
    await f.post(
      {
        command: 'project.create',
        payload: { id: 'p', area: 'agency', name: 'P', color: '#112233' },
      },
      { id: 'owner-project' },
    ),
  );
  success(
    await f.post(
      {
        command: 'task.create',
        payload: { id: 't', area: 'agency', title: 'Владельца' },
      },
      { id: 'owner-task' },
    ),
  );
  success(
    await f.post(
      {
        command: 'task.create',
        payload: { id: 'ta', area: 'agency', title: 'Агента' },
      },
      { id: 'agent-task', role: 'agent' },
    ),
  );
  success(
    await f.post(
      {
        command: 'comment.add',
        payload: { id: 'c', taskId: 'ta', text: 'Комментарий агента' },
      },
      { id: 'agent-comment', role: 'agent' },
    ),
  );
  // Spec 2026-09-25: the night shift queued and showed one proposal (№ 1).
  success(
    await f.post(proposal('pr', 'seeded'), {
      id: 'night-proposal',
      role: 'propose',
    }),
  );
  success(
    await f.post(
      { command: 'proposal.deliver', payload: {} },
      { id: 'night-deliver', role: 'propose' },
    ),
  );
  return f;
}
const proposal = (id: string, fingerprint: string): Command => ({
  command: 'proposal.create',
  payload: {
    id,
    kind: 'new_task',
    command: {
      command: 'task.create',
      payload: { area: 'agency', title: 'Предложенная задача' },
    },
    reason: 'Договорились',
    evidence: [{ source: 'board', ref: 'ta', at: '2026-09-08', quote: 'Да' }],
    fingerprint,
    rank: 2,
  },
});
const PROPOSE_ONLY =
  'Ключ propose только предлагает: доступны proposal create и proposal deliver.';
const task = (f: ReturnType<typeof setup>, id: string): Task =>
  f.state().tasks.find((t) => t.id === id)!;
describe('permission matrix: direct commands', () => {
  const cases: {
    title: string;
    role: string;
    command: (f: ReturnType<typeof setup>) => Command;
    status: number;
    message?: string;
  }[] = [
    {
      title: 'owner creates a project',
      role: 'owner',
      status: 200,
      command: () => ({
        command: 'project.create',
        payload: { area: 'agency', name: 'New', color: '#000000' },
      }),
    },
    {
      title: 'write agent creates a project',
      role: 'agent',
      status: 200,
      command: () => ({
        command: 'project.create',
        payload: { area: 'agency', name: 'New', color: '#000000' },
      }),
    },
    {
      title: 'tasks agent cannot create a project',
      role: 'tasks',
      status: 403,
      command: () => ({
        command: 'project.create',
        payload: { area: 'agency', name: 'New', color: '#000000' },
      }),
    },
    {
      title: 'read agent cannot create a project',
      role: 'read',
      status: 403,
      command: () => ({
        command: 'project.create',
        payload: { area: 'agency', name: 'New', color: '#000000' },
      }),
    },
    {
      title: 'tasks agent updates a task without focus',
      role: 'tasks',
      status: 200,
      command: (f) => ({
        command: 'task.update',
        payload: { id: 'ta', baseRevision: task(f, 'ta').revision, note: 'n' },
      }),
    },
    {
      title: 'read agent cannot update a task',
      role: 'read',
      status: 403,
      command: (f) => ({
        command: 'task.update',
        payload: { id: 'ta', baseRevision: task(f, 'ta').revision, note: 'n' },
      }),
    },
    {
      title: 'owner sets focus',
      role: 'owner',
      status: 200,
      command: (f) => ({
        command: 'task.update',
        payload: {
          id: 'ta',
          baseRevision: task(f, 'ta').revision,
          focus: true,
        },
      }),
    },
    {
      title: 'write agent cannot create with focus',
      role: 'agent',
      status: 403,
      message: FOCUS_ONLY_OWNER,
      command: () => ({
        command: 'task.create',
        payload: { area: 'agency', title: 'F', focus: true },
      }),
    },
    {
      title: 'tasks agent cannot update focus',
      role: 'tasks',
      status: 403,
      message: FOCUS_ONLY_OWNER,
      command: (f) => ({
        command: 'task.update',
        payload: {
          id: 'ta',
          baseRevision: task(f, 'ta').revision,
          focus: true,
        },
      }),
    },
    {
      title: 'write agent cannot unset focus either',
      role: 'agent',
      status: 403,
      message: FOCUS_ONLY_OWNER,
      command: (f) => ({
        command: 'task.update',
        payload: {
          id: 'ta',
          baseRevision: task(f, 'ta').revision,
          focus: false,
        },
      }),
    },
    {
      title: 'write agent cannot set a focus position (plan 13, step 4)',
      role: 'agent',
      status: 403,
      message: FOCUS_ONLY_OWNER,
      command: (f) => ({
        command: 'task.update',
        payload: {
          id: 'ta',
          baseRevision: task(f, 'ta').revision,
          focusPosition: { first: true },
        },
      }),
    },
    {
      title: 'tasks agent cannot save a focus position inside fields',
      role: 'tasks',
      status: 403,
      message: FOCUS_ONLY_OWNER,
      command: (f) => ({
        command: 'task.save',
        payload: {
          id: 'ta',
          baseRevision: task(f, 'ta').revision,
          fields: { focusPosition: { after: 't' } },
        },
      }),
    },
    {
      title: 'owner puts a task first on the desk',
      role: 'owner',
      status: 200,
      command: (f) => ({
        command: 'task.update',
        payload: {
          id: 'ta',
          baseRevision: task(f, 'ta').revision,
          focusPosition: { first: true },
        },
      }),
    },
    {
      title: 'write agent cannot save focus inside fields',
      role: 'agent',
      status: 403,
      message: FOCUS_ONLY_OWNER,
      command: (f) => ({
        command: 'task.save',
        payload: {
          id: 'ta',
          baseRevision: task(f, 'ta').revision,
          fields: { focus: true },
        },
      }),
    },
    {
      title: 'tasks agent adds a checklist step',
      role: 'tasks',
      status: 200,
      command: (f) => ({
        command: 'checklist.add',
        payload: {
          taskId: 'ta',
          baseRevision: task(f, 'ta').revision,
          text: 'Шаг',
        },
      }),
    },
    {
      title: 'read agent cannot add a checklist step',
      role: 'read',
      status: 403,
      command: (f) => ({
        command: 'checklist.add',
        payload: {
          taskId: 'ta',
          baseRevision: task(f, 'ta').revision,
          text: 'Шаг',
        },
      }),
    },
    {
      title: 'tasks agent comments',
      role: 'tasks',
      status: 200,
      command: () => ({
        command: 'comment.add',
        payload: { taskId: 'ta', text: 'x' },
      }),
    },
    {
      title: 'read agent cannot comment',
      role: 'read',
      status: 403,
      command: () => ({
        command: 'comment.add',
        payload: { taskId: 'ta', text: 'x' },
      }),
    },
    {
      title: 'agent removes its own comment',
      role: 'agent',
      status: 200,
      command: () => ({
        command: 'comment.remove',
        payload: { commentId: 'c' },
      }),
    },
    {
      title: 'another agent cannot remove that comment',
      role: 'agent2',
      status: 403,
      command: () => ({
        command: 'comment.remove',
        payload: { commentId: 'c' },
      }),
    },
    {
      title: 'owner removes any comment',
      role: 'owner',
      status: 200,
      command: () => ({
        command: 'comment.remove',
        payload: { commentId: 'c' },
      }),
    },
    // Scope propose (spec 2026-09-25, plan §1.4): every read, two writes.
    {
      title: 'propose agent creates a proposal',
      role: 'propose',
      status: 200,
      command: () => proposal('pr-2', 'second'),
    },
    {
      title: 'propose agent delivers proposals',
      role: 'propose',
      status: 200,
      command: () => ({ command: 'proposal.deliver', payload: { limit: 5 } }),
    },
    ...(
      [
        [
          'task.create',
          () => ({
            command: 'task.create',
            payload: { area: 'agency', title: 'Сам' },
          }),
        ],
        [
          'task.update',
          (f) => ({
            command: 'task.update',
            payload: {
              id: 'ta',
              baseRevision: task(f, 'ta').revision,
              note: 'n',
            },
          }),
        ],
        [
          'comment.add',
          () => ({
            command: 'comment.add',
            payload: { taskId: 'ta', text: 'Ночью' },
          }),
        ],
        [
          'proposal.accept',
          () => ({ command: 'proposal.accept', payload: { ref: '1' } }),
        ],
        [
          'proposal.reject',
          () => ({ command: 'proposal.reject', payload: { ref: '1' } }),
        ],
        [
          'undo',
          () => ({
            command: 'undo',
            payload: { operationId: 'night-proposal' },
          }),
        ],
      ] as [string, (f: ReturnType<typeof setup>) => Command][]
    ).map(([name, command]) => ({
      title: `propose agent cannot ${name}`,
      role: 'propose',
      status: 403,
      message: PROPOSE_ONLY,
      command,
    })),
    {
      title: 'read agent cannot create a proposal',
      role: 'read',
      status: 403,
      command: () => proposal('pr-3', 'third'),
    },
    {
      title: 'tasks agent creates a proposal',
      role: 'tasks',
      status: 200,
      command: () => proposal('pr-4', 'fourth'),
    },
    {
      title: 'write agent accepts a shown proposal',
      role: 'agent',
      status: 200,
      command: () => ({ command: 'proposal.accept', payload: { ref: '1' } }),
    },
    {
      title: 'tasks agent rejects a shown proposal',
      role: 'tasks',
      status: 200,
      command: () => ({
        command: 'proposal.reject',
        payload: { ref: 'pr', reason: 'Не нужно' },
      }),
    },
    {
      title: 'read agent cannot accept a proposal',
      role: 'read',
      status: 403,
      command: () => ({ command: 'proposal.accept', payload: { ref: '1' } }),
    },
    {
      title: 'owner accepts a proposal',
      role: 'owner',
      status: 200,
      command: () => ({ command: 'proposal.accept', payload: { ref: 'pr' } }),
    },
  ];
  it.each(cases)('$title', async ({ role, command, status, message }) => {
    const f = await seed(setup());
    const before = snapshot(f);
    const response = await f.post(command(f), { role });
    expect(response.status).toBe(status);
    if (status !== 200) {
      expect(response.body).toMatchObject({ ok: false, code: 'forbidden' });
      if (message)
        expect((response.body as OperationError).message).toBe(message);
      expect(snapshot(f)).toBe(before);
    }
  });
  it('rejects a whole batch when one command sets focus, with commandIndex and no state change', async () => {
    const f = await seed(setup());
    const before = snapshot(f);
    const revision = task(f, 'ta').revision;
    const response = await f.batch(
      [
        {
          command: 'task.update',
          payload: { id: 'ta', baseRevision: revision, note: 'ok' },
        },
        {
          command: 'task.update',
          payload: { id: 'ta', baseRevision: revision, focus: true },
        },
      ],
      { role: 'agent' },
    );
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: 'forbidden',
      message: FOCUS_ONLY_OWNER,
      commandIndex: 1,
    });
    expect(snapshot(f)).toBe(before);
  });
});
describe('focus in task.sync', () => {
  it('always skips focus for agents (reason owner) so synced tasks land in "new", while the owner selects', async () => {
    const f = setup();
    const created = success(
      await f.post(
        {
          command: 'task.sync',
          payload: {
            origin: { system: 'telegram', ref: '1', version: '1' },
            fields: { area: 'agency', title: 'Из источника', focus: true },
          },
        },
        { role: 'agent' },
      ),
    );
    expect(created.results[0]).toMatchObject({
      skipped: [{ field: 'focus', reason: 'owner' }],
    });
    expect((created.results[0]!.record as Task).focus).toBe(false);
    expect((created.results[0]!.applied as string[]).includes('focus')).toBe(
      false,
    );
    const synced = task(f, (created.results[0]!.record as Task).id);
    expect(synced.ownerTouchedAt).toBeNull();
    const groups = focusGroups(f.state().tasks, '2026-09-08');
    expect(
      groups.find((g) => g.tasks.some((t) => t.id === synced.id))?.id,
    ).toBe('new');
    const updated = success(
      await f.post(
        {
          command: 'task.sync',
          payload: {
            origin: { system: 'telegram', ref: '1', version: '2' },
            fields: {
              area: 'agency',
              title: 'Из источника',
              note: 'v2',
              focus: true,
            },
          },
        },
        { role: 'tasks' },
      ),
    );
    expect(updated.results[0]).toMatchObject({
      applied: expect.arrayContaining(['note']),
      skipped: [{ field: 'focus', reason: 'owner' }],
    });
    expect((updated.results[0]!.applied as string[]).includes('focus')).toBe(
      false,
    );
    expect(task(f, synced.id).focus).toBe(false);
    success(
      await f.post({
        command: 'task.update',
        payload: {
          id: synced.id,
          baseRevision: task(f, synced.id).revision,
          focus: true,
        },
      }),
    );
    expect(
      focusGroups(f.state().tasks, '2026-09-08').find((g) =>
        g.tasks.some((t) => t.id === synced.id),
      )?.id,
    ).toBe('selected');
  });
});
describe('undo authority', () => {
  it('lets no agent undo an operation with owner events, by operationId or by seq; the owner undoes anything', async () => {
    const f = await seed(setup());
    const archived = success(
      await f.post(
        {
          command: 'task.archive',
          payload: { id: 't', baseRevision: task(f, 't').revision },
        },
        { id: 'owner-archive' },
      ),
    );
    for (const role of ['agent', 'tasks']) {
      const before = snapshot(f);
      for (const payload of [
        { operationId: 'owner-archive' },
        { seq: archived.firstSeq! },
      ]) {
        const denied = await f.post({ command: 'undo', payload }, { role });
        expect(denied.status).toBe(403);
        expect(denied.body).toMatchObject({
          code: 'forbidden',
          message: OWNER_DECISION,
        });
      }
      expect(snapshot(f)).toBe(before);
    }
    expect(task(f, 't')).toMatchObject({
      archived: true,
      ownerFields: expect.arrayContaining(['archived']),
    });
    expect(
      (
        await f.post({
          command: 'undo',
          payload: { operationId: 'agent-comment' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.post({
          command: 'undo',
          payload: { operationId: 'owner-archive' },
        })
      ).status,
    ).toBe(200);
    expect(task(f, 't').archived).toBe(false);
  });
  it("lets an agent undo its own and another agent's operations within scope, but not a foreign comment or a project for a tasks key", async () => {
    const f = await seed(setup());
    success(
      await f.post(
        {
          command: 'checklist.add',
          payload: {
            taskId: 'ta',
            baseRevision: task(f, 'ta').revision,
            text: 'Шаг',
          },
        },
        { id: 'agent-step', role: 'agent' },
      ),
    );
    const before = snapshot(f);
    const byOther = await f.post(
      { command: 'undo', payload: { operationId: 'agent-step' } },
      { role: 'agent2' },
    );
    expect(byOther.status).toBe(200);
    expect(task(f, 'ta').checklist).toEqual([]);
    expect(snapshot(f)).not.toBe(before);
    const own = await f.post(
      { command: 'undo', payload: { operationId: 'agent-comment' } },
      { role: 'agent' },
    );
    expect(own.status).toBe(200);
    success(
      await f.post(
        {
          command: 'comment.add',
          payload: { id: 'c2', taskId: 'ta', text: 'Ещё' },
        },
        { id: 'agent-comment-2', role: 'agent' },
      ),
    );
    const foreignComment = await f.post(
      { command: 'undo', payload: { operationId: 'agent-comment-2' } },
      { role: 'agent2' },
    );
    expect(foreignComment.status).toBe(403);
    success(
      await f.post(
        {
          command: 'project.update',
          payload: {
            id: 'p',
            baseRevision: f.state().projects.find((p) => p.id === 'p')!
              .revision,
            name: 'Renamed',
          },
        },
        { id: 'agent-rename', role: 'agent' },
      ),
    );
    expect(
      (
        await f.post(
          { command: 'undo', payload: { operationId: 'agent-rename' } },
          { role: 'tasks' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.post(
          { command: 'undo', payload: { operationId: 'agent-rename' } },
          { role: 'agent2' },
        )
      ).status,
    ).toBe(200);
    success(
      await f.post(
        {
          command: 'project.create',
          payload: { id: 'p2', area: 'agency', name: 'P2', color: '#000000' },
        },
        { id: 'agent-project', role: 'agent' },
      ),
    );
    expect(
      (
        await f.post(
          { command: 'undo', payload: { operationId: 'agent-project' } },
          { role: 'tasks' },
        )
      ).body,
    ).toMatchObject({ code: 'forbidden' });
    expect(
      (
        await f.post(
          { command: 'undo', payload: { operationId: 'agent-project' } },
          { role: 'agent' },
        )
      ).body,
    ).toMatchObject({ code: 'not_undoable' });
    expect(
      (
        await f.post({
          command: 'undo',
          payload: { operationId: 'agent-project' },
        })
      ).body,
    ).toMatchObject({ code: 'not_undoable' });
  });
});
describe('owner fields need an explicit confirmation from agents', () => {
  it('TI-086: a priority the owner set is an owner field; labels and closes follow the same rule', async () => {
    const f = await seed(setup());
    success(
      await f.post({
        command: 'task.update',
        payload: {
          id: 'ta',
          baseRevision: task(f, 'ta').revision,
          priority: 'p1',
          labels: ['dengi'],
          closes: 'lora-km-of-vacancy',
        },
      }),
    );
    expect(task(f, 'ta').ownerFields).toEqual(
      expect.arrayContaining(['priority', 'labels', 'closes']),
    );
    const refused = await f.post(
      {
        command: 'task.update',
        payload: {
          id: 'ta',
          baseRevision: task(f, 'ta').revision,
          priority: 'p2',
          labels: [],
          closes: null,
        },
      },
      { role: 'agent' },
    );
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining(PROTECTED),
      conflicts: [
        {
          entityKind: 'task',
          entityId: 'ta',
          fields: ['priority', 'labels', 'closes'],
        },
      ],
    });
    expect(task(f, 'ta').priority).toBe('p1');
    const confirmed = success(
      await f.post(
        {
          command: 'task.update',
          payload: {
            id: 'ta',
            baseRevision: task(f, 'ta').revision,
            priority: 'p2',
            labels: [],
            closes: null,
          },
        },
        { role: 'agent', confirmOwnerFields: true },
      ),
    );
    expect(confirmed.results[0]).toMatchObject({
      confirmedOwnerFields: ['priority', 'labels', 'closes'],
    });
    expect(task(f, 'ta')).toMatchObject({
      priority: 'p2',
      labels: [],
      closes: null,
    });
  });
  it('TI-086: a field the owner never changed stays open to a direct agent command, as every other field (spec §4.1)', async () => {
    const f = await seed(setup());
    // The owner changes the note only: ownerFields = ['note'].
    success(
      await f.post({
        command: 'task.update',
        payload: {
          id: 'ta',
          baseRevision: task(f, 'ta').revision,
          note: 'Владелец',
        },
      }),
    );
    expect(task(f, 'ta').ownerFields).toEqual(['note']);
    const direct = await f.post(
      {
        command: 'task.update',
        payload: {
          id: 'ta',
          baseRevision: task(f, 'ta').revision,
          priority: 'p1',
          labels: ['dengi'],
          closes: 'lora-km-of-vacancy',
        },
      },
      { role: 'agent' },
    );
    expect(direct.status).toBe(200);
    expect(success(direct).results[0]!.confirmedOwnerFields).toBeUndefined();
    expect(task(f, 'ta')).toMatchObject({ priority: 'p1', labels: ['dengi'] });
  });
  it('requires confirmOwnerFields for a direct command that changes a field the owner decided on, and records the confirmation', async () => {
    const f = await seed(setup());
    success(
      await f.post({
        command: 'task.archive',
        payload: { id: 't', baseRevision: task(f, 't').revision },
      }),
    );
    success(
      await f.post({
        command: 'task.move',
        payload: {
          id: 'ta',
          baseRevision: task(f, 'ta').revision,
          status: 'done',
        },
      }),
    );
    const before = snapshot(f);
    const restore = await f.post(
      {
        command: 'task.restore',
        payload: { id: 't', baseRevision: task(f, 't').revision },
      },
      { role: 'agent' },
    );
    expect(restore.status).toBe(403);
    expect(restore.body).toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining(PROTECTED),
      conflicts: [{ entityKind: 'task', entityId: 't', fields: ['archived'] }],
    });
    const reopen = await f.post(
      {
        command: 'task.move',
        payload: {
          id: 'ta',
          baseRevision: task(f, 'ta').revision,
          status: 'todo',
        },
      },
      { role: 'tasks' },
    );
    expect(reopen.status).toBe(403);
    expect(reopen.body).toMatchObject({
      code: 'forbidden',
      conflicts: [{ entityKind: 'task', entityId: 'ta', fields: ['status'] }],
    });
    expect(snapshot(f)).toBe(before);
    // Untouched fields and unchanged values need no confirmation.
    expect(
      (
        await f.post(
          {
            command: 'task.update',
            payload: {
              id: 'ta',
              baseRevision: task(f, 'ta').revision,
              note: 'заметка',
            },
          },
          { role: 'agent' },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.post(
          {
            command: 'task.save',
            payload: {
              id: 'ta',
              baseRevision: task(f, 'ta').revision,
              status: 'done',
              fields: { title: 'Агента' },
            },
          },
          { role: 'agent' },
        )
      ).status,
    ).toBe(200);
    expect(task(f, 'ta').status).toBe('done');
    const confirmed = await f.post(
      {
        command: 'task.restore',
        payload: { id: 't', baseRevision: task(f, 't').revision },
      },
      { role: 'agent', id: 'agent-restore', confirmOwnerFields: true },
    );
    expect(confirmed.status).toBe(200);
    expect(success(confirmed).results[0]).toMatchObject({
      confirmedOwnerFields: ['archived'],
    });
    expect(task(f, 't')).toMatchObject({
      archived: false,
      ownerFields: expect.arrayContaining(['archived']),
    });
    const stored = await f.app.request('/api/operations/agent-restore');
    expect(((await stored.json()) as StoredOperation).result).toMatchObject({
      results: [{ confirmedOwnerFields: ['archived'] }],
    });
    // The flag is not a blanket permission: focus stays owner-only and it never touches ownerFields.
    const focus = await f.post(
      {
        command: 'task.update',
        payload: { id: 't', baseRevision: task(f, 't').revision, focus: true },
      },
      { role: 'agent', confirmOwnerFields: true },
    );
    expect(focus.body).toMatchObject({
      code: 'forbidden',
      message: FOCUS_ONLY_OWNER,
    });
    const owner = await f.post(
      {
        command: 'task.archive',
        payload: { id: 't', baseRevision: task(f, 't').revision },
      },
      { confirmOwnerFields: true },
    );
    expect(success(owner).results[0]!.confirmedOwnerFields).toBeUndefined();
  });
  // TI-095 (owner decision 2026-09-18): steps are records of their own, and
  // the owner's touch protects the step and the fields he decided on, never
  // the list as a whole. An agent working through the plan ticks steps,
  // appends new ones and rewords steps the owner never touched without a
  // flag; rewording, removing or moving the owner's steps, or clearing his
  // tick, needs confirmOwnerFields.
  const stepOf = (f: ReturnType<typeof setup>, id: string) =>
    task(f, 'ta').checklist.find((item) => item.id === id)!;
  it("TI-095: the owner's edit protects that step only: an agent ticks it, appends steps and rewords the others without confirmation", async () => {
    const f = await seed(setup());
    success(
      await f.post(
        {
          command: 'task.save',
          payload: {
            id: 'ta',
            baseRevision: task(f, 'ta').revision,
            checklist: [
              { id: 's1', text: 'Первый', done: false },
              { id: 's2', text: 'Второй', done: false },
            ],
          },
        },
        { role: 'agent' },
      ),
    );
    // The owner fixes the wording of the first step: that step's text is his.
    success(
      await f.post({
        command: 'checklist.update',
        payload: {
          taskId: 'ta',
          baseRevision: stepOf(f, 's1').revision,
          itemId: 's1',
          text: 'Первый шаг',
        },
      }),
    );
    const s1 = f.state().steps.find((s) => s.id === 's1')!;
    expect(s1.ownerFields).toEqual(['text']);
    expect(s1.ownerTouchedAt).not.toBeNull();
    expect(task(f, 'ta').ownerTouchedAt).toBeNull();
    const tick = await f.post(
      {
        command: 'checklist.update',
        payload: {
          taskId: 'ta',
          baseRevision: stepOf(f, 's1').revision,
          itemId: 's1',
          done: true,
        },
      },
      { role: 'agent' },
    );
    expect(tick.status).toBe(200);
    expect(success(tick).results[0]!.confirmedOwnerFields).toBeUndefined();
    expect(stepOf(f, 's1')).toMatchObject({
      done: true,
      doneBy: 'agent:test-agent',
      doneByLabel: 'Тестовый агент',
      doneAt: '2026-09-08T12:00:00.000Z',
    });
    const add = await f.post(
      {
        command: 'checklist.add',
        payload: { taskId: 'ta', id: 's3', text: 'Третий', position: 1 },
      },
      { role: 'agent' },
    );
    expect(add.status).toBe(200);
    expect(task(f, 'ta').checklist.map((i) => i.id)).toEqual([
      's1',
      's3',
      's2',
    ]);
    // A step the owner never touched is the agent's to reword.
    const reword = await f.post(
      {
        command: 'checklist.update',
        payload: {
          taskId: 'ta',
          baseRevision: stepOf(f, 's2').revision,
          itemId: 's2',
          text: 'Второй, уточнённый',
          result: 'PR #12',
        },
      },
      { role: 'agent' },
    );
    expect(reword.status).toBe(200);
    // A full save that ticks, appends and keeps the owner's wording passes.
    const items = task(f, 'ta').checklist;
    const save = await f.post(
      {
        command: 'task.save',
        payload: {
          id: 'ta',
          baseRevision: task(f, 'ta').revision,
          checklist: [
            ...items.map((item) => ({
              id: item.id,
              text: item.text,
              done: true,
              revision: item.revision,
            })),
            { id: 's4', text: 'Четвёртый' },
          ],
        },
      },
      { role: 'agent' },
    );
    expect(save.status).toBe(200);
    expect(success(save).results[0]!.confirmedOwnerFields).toBeUndefined();
    expect(task(f, 'ta').checklist.map((i) => [i.id, i.done])).toEqual([
      ['s1', true],
      ['s3', true],
      ['s2', true],
      ['s4', false],
    ]);
    expect(task(f, 'ta').ownerFields).toEqual([]);
  });
  it('TI-095: rewording, removing, moving a step the owner decided on or clearing his tick needs confirmation, per step, in single commands and batches', async () => {
    const f = await seed(setup());
    success(
      await f.post(
        {
          command: 'task.save',
          payload: {
            id: 'ta',
            baseRevision: task(f, 'ta').revision,
            checklist: [
              { id: 's1', text: 'Первый', done: false },
              { id: 's2', text: 'Второй', done: false },
            ],
          },
        },
        { role: 'agent' },
      ),
    );
    // The owner rewords the first step, ticks the second and writes a third.
    success(
      await f.post({
        command: 'checklist.update',
        payload: {
          taskId: 'ta',
          baseRevision: stepOf(f, 's1').revision,
          itemId: 's1',
          text: 'Первый шаг',
        },
      }),
    );
    success(
      await f.post({
        command: 'checklist.update',
        payload: {
          taskId: 'ta',
          baseRevision: stepOf(f, 's2').revision,
          itemId: 's2',
          done: true,
        },
      }),
    );
    success(
      await f.post({
        command: 'checklist.add',
        payload: { taskId: 'ta', id: 's3', text: 'Третий' },
      }),
    );
    // Writing a step decides its wording, place and existence, not its tick.
    expect(f.state().steps.find((s) => s.id === 's3')!.ownerFields).toEqual([
      'orderKey',
      'removedAt',
      'text',
    ]);
    const before = snapshot(f);
    const rev = (id: string) => stepOf(f, id).revision;
    const overriding: [() => Command, string, string][] = [
      [
        () => ({
          command: 'checklist.update',
          payload: {
            taskId: 'ta',
            baseRevision: rev('s1'),
            itemId: 's1',
            text: 'Другой текст',
          },
        }),
        's1',
        'text',
      ],
      [
        () => ({
          command: 'checklist.update',
          payload: {
            taskId: 'ta',
            baseRevision: rev('s2'),
            itemId: 's2',
            done: false,
          },
        }),
        's2',
        'done',
      ],
      [
        () => ({
          command: 'checklist.remove',
          payload: { taskId: 'ta', baseRevision: rev('s1'), itemId: 's1' },
        }),
        's1',
        'removedAt',
      ],
      [
        () => ({
          command: 'checklist.move',
          payload: {
            taskId: 'ta',
            baseRevision: rev('s3'),
            itemId: 's3',
            before: 's1',
          },
        }),
        's3',
        'orderKey',
      ],
      [
        () => ({
          command: 'checklist.reorder',
          payload: { taskId: 'ta', itemIds: ['s3', 's1', 's2'] },
        }),
        's3',
        'orderKey',
      ],
    ];
    for (const [command, entityId, field] of overriding) {
      const refused = await f.post(command(), { role: 'agent' });
      expect(refused.body).toMatchObject({
        code: 'forbidden',
        conflicts: [{ entityKind: 'step', entityId, fields: [field] }],
      });
    }
    // Ticking the owner's third step is the agent's ordinary work.
    const tick = await f.post(
      {
        command: 'checklist.update',
        payload: {
          taskId: 'ta',
          baseRevision: rev('s3'),
          itemId: 's3',
          done: true,
        },
      },
      { role: 'agent' },
    );
    expect(tick.status).toBe(200);
    const batch = await f.batch(
      [
        {
          command: 'task.update',
          payload: {
            id: 'ta',
            baseRevision: task(f, 'ta').revision,
            note: 'ok',
          },
        },
        {
          command: 'checklist.remove',
          payload: { taskId: 'ta', baseRevision: rev('s3'), itemId: 's3' },
        },
      ],
      { role: 'agent' },
    );
    expect(batch.body).toMatchObject({ code: 'forbidden', commandIndex: 1 });
    expect(task(f, 'ta').note).toBe('');
    expect(stepOf(f, 's1').text).toBe('Первый шаг');
    expect(before).not.toBe(snapshot(f)); // the tick above did land
    const confirmed = await f.batch(
      [
        {
          command: 'task.update',
          payload: {
            id: 'ta',
            baseRevision: task(f, 'ta').revision,
            note: 'ok',
          },
        },
        {
          command: 'checklist.remove',
          payload: { taskId: 'ta', baseRevision: rev('s3'), itemId: 's3' },
        },
      ],
      { role: 'agent', confirmOwnerFields: true },
    );
    expect(confirmed.status).toBe(200);
    expect(
      success(confirmed).results.map((r) => r.confirmedOwnerFields),
    ).toEqual([undefined, ['removedAt']]);
    expect(task(f, 'ta').checklist.map((i) => i.id)).toEqual(['s1', 's2']);
    // The removed step stays a record: undo brings it back.
    const undone = await f.post(
      {
        command: 'undo',
        payload: { operationId: success(confirmed).operationId },
      },
      { role: 'agent' },
    );
    expect(undone.status).toBe(200);
    expect(task(f, 'ta').checklist.map((i) => i.id)).toEqual([
      's1',
      's2',
      's3',
    ]);
  });
  // Owner decision 2026-09-26: undoing its own confirmed write restores the
  // owner's value, but undoing that undo writes the change again, so it needs
  // the same confirmation as the direct write.
  it('TI-096: requires confirmOwnerFields to undo an undo that writes an owner field again, by operation and by seq; other fields redo freely', async () => {
    const f = await seed(setup());
    const step = () => f.state().steps.find((s) => s.id === 'os')!;
    success(
      await f.post({
        command: 'checklist.add',
        payload: { taskId: 't', id: 'os', text: 'Шаг владельца' },
      }),
    );
    success(
      await f.post(
        {
          command: 'checklist.remove',
          payload: { taskId: 't', baseRevision: step().revision, itemId: 'os' },
        },
        { role: 'agent', id: 'agent-remove', confirmOwnerFields: true },
      ),
    );
    const unremove = success(
      await f.post(
        { command: 'undo', payload: { operationId: 'agent-remove' } },
        { role: 'agent', id: 'agent-unremove' },
      ),
    );
    expect(step().removedAt).toBeNull();
    const before = snapshot(f);
    for (const payload of [
      { operationId: 'agent-unremove' },
      { seq: unremove.firstSeq! },
    ]) {
      const denied = await f.post(
        { command: 'undo', payload },
        { role: 'agent' },
      );
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({
        code: 'forbidden',
        message: expect.stringContaining(PROTECTED),
        conflicts: [
          { entityKind: 'step', entityId: 'os', fields: ['removedAt'] },
        ],
      });
    }
    expect(snapshot(f)).toBe(before);
    const redone = await f.post(
      { command: 'undo', payload: { operationId: 'agent-unremove' } },
      { role: 'agent', confirmOwnerFields: true },
    );
    expect(success(redone).results[0]).toMatchObject({
      confirmedOwnerFields: ['removedAt'],
    });
    expect(step().removedAt).not.toBeNull();
    // A task field: the title of the owner's task.
    success(
      await f.post(
        {
          command: 'task.update',
          payload: {
            id: 't',
            baseRevision: task(f, 't').revision,
            title: 'Агента',
          },
        },
        { role: 'agent', id: 'agent-rename', confirmOwnerFields: true },
      ),
    );
    success(
      await f.post(
        { command: 'undo', payload: { operationId: 'agent-rename' } },
        { role: 'agent', id: 'agent-unrename' },
      ),
    );
    expect(task(f, 't').title).toBe('Владельца');
    const rename = await f.post(
      { command: 'undo', payload: { operationId: 'agent-unrename' } },
      { role: 'agent' },
    );
    expect(rename.body).toMatchObject({
      code: 'forbidden',
      conflicts: [{ entityKind: 'task', entityId: 't', fields: ['title'] }],
    });
    expect(task(f, 't').title).toBe('Владельца');
    // A field the owner never decided on redoes without confirmation.
    success(
      await f.post(
        {
          command: 'task.update',
          payload: {
            id: 'ta',
            baseRevision: task(f, 'ta').revision,
            note: 'заметка',
          },
        },
        { role: 'agent', id: 'agent-note' },
      ),
    );
    success(
      await f.post(
        { command: 'undo', payload: { operationId: 'agent-note' } },
        { role: 'agent', id: 'agent-unnote' },
      ),
    );
    success(
      await f.post(
        { command: 'undo', payload: { operationId: 'agent-unnote' } },
        { role: 'agent' },
      ),
    );
    expect(task(f, 'ta').note).toBe('заметка');
  });
});
it('states the policy in /api/context rules', async () => {
  const f = setup();
  const context = (await (await f.app.request('/api/context')).json()) as {
    rules: string[];
  };
  const rules = context.rules.join('\n');
  for (const phrase of [
    'событиями владельца',
    'focus',
    'confirmOwnerFields',
    'ревизия шага',
    'checklist.promote',
    'appearance.update',
  ])
    expect(rules).toContain(phrase);
});
