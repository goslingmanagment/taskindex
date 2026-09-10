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
  return f;
}
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
  it('protects the whole checklist once the owner touched it, in single commands and batches, until confirmed', async () => {
    const f = await seed(setup());
    success(
      await f.post(
        {
          command: 'checklist.add',
          payload: {
            id: 's1',
            taskId: 'ta',
            baseRevision: task(f, 'ta').revision,
            text: 'Шаг агента',
          },
        },
        { role: 'agent' },
      ),
    );
    success(
      await f.post({
        command: 'checklist.update',
        payload: {
          taskId: 'ta',
          baseRevision: task(f, 'ta').revision,
          itemId: 's1',
          done: true,
        },
      }),
    );
    expect(task(f, 'ta').ownerFields).toContain('checklist');
    const before = snapshot(f);
    const add = await f.post(
      {
        command: 'checklist.add',
        payload: {
          taskId: 'ta',
          baseRevision: task(f, 'ta').revision,
          text: 'Ещё шаг',
        },
      },
      { role: 'agent' },
    );
    expect(add.body).toMatchObject({
      code: 'forbidden',
      conflicts: [{ fields: ['checklist'] }],
    });
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
          payload: {
            taskId: 'ta',
            baseRevision: task(f, 'ta').revision,
            itemId: 's1',
          },
        },
      ],
      { role: 'agent' },
    );
    expect(batch.body).toMatchObject({ code: 'forbidden', commandIndex: 1 });
    expect(snapshot(f)).toBe(before);
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
          command: 'checklist.add',
          payload: {
            taskId: 'ta',
            baseRevision: task(f, 'ta').revision,
            text: 'Ещё шаг',
          },
        },
      ],
      { role: 'agent', confirmOwnerFields: true },
    );
    expect(confirmed.status).toBe(200);
    expect(
      success(confirmed).results.map((r) => r.confirmedOwnerFields),
    ).toEqual([undefined, ['checklist']]);
    expect(task(f, 'ta').checklist).toHaveLength(2);
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
    'чеклист',
  ])
    expect(rules).toContain(phrase);
});
