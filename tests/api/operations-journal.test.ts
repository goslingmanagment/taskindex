import { describe, it, expect } from 'vitest';
import { fixture, success } from './helpers.js';
import { openDatabase, migrate, readOperations } from '../../src/server/db.js';
import { exportWorkspace, importWorkspace } from '../../src/server/admin.js';
import type { OperationError } from '../../src/shared/model.js';
type Summary = { id: string; operationSeq: number; lastSeq: number | null };
type Page = { items: Summary[]; more: boolean; nextCursor: string | null };
const ids = (page: Page) => page.items.map((i) => i.id);
async function list(f: ReturnType<typeof fixture>, query: string) {
  const response = await f.app.request(`/api/operations${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Page;
}
async function walk(f: ReturnType<typeof fixture>, extra = '') {
  const seen: Summary[] = [];
  let after = 0;
  for (let pages = 0; pages < 20; pages++) {
    const page = await list(f, `?after=${after}&limit=1${extra}`);
    if (!page.items.length) return seen;
    seen.push(...page.items);
    after = page.items.at(-1)!.operationSeq;
  }
  throw new Error(
    `after= did not converge: ${JSON.stringify(seen.map((s) => s.id))}`,
  );
}
describe('TI-008 operation journal cursor', () => {
  it('reads success, no-op, rejection, repeat and success completely with after= and limit=1; since=0 and no since mean everything', async () => {
    const f = fixture();
    const create = {
      command: 'task.create' as const,
      payload: { id: 'e', area: 'agency' as const, title: 'I' },
    };
    success(await f.post(create, { id: 'initial' }));
    success(
      await f.post(
        {
          command: 'task.update',
          payload: { id: 'e', baseRevision: 1, title: 'I' },
        },
        { id: 'noop' },
      ),
    );
    const rejected = await f.post(
      {
        command: 'task.create',
        payload: { id: 'e', area: 'agency', title: 'X' },
      },
      { id: 'rejected' },
    );
    expect(rejected.status).toBe(409);
    const repeat = await f.post(create, { id: 'initial' });
    expect(repeat.status).toBe(200);
    success(
      await f.post(
        {
          command: 'task.create',
          payload: { id: 'e2', area: 'agency', title: 'S' },
        },
        { id: 'second' },
      ),
    );
    const walked = await walk(f);
    expect(walked.map((o) => [o.id, o.operationSeq])).toEqual([
      ['initial', 1],
      ['noop', 2],
      ['rejected', 3],
      ['second', 4],
    ]);
    // The repeat of `initial` did not create a new journal position.
    expect(walked).toHaveLength(4);
    expect(ids(await list(f, ''))).toEqual([
      'second',
      'rejected',
      'noop',
      'initial',
    ]);
    expect(ids(await list(f, '?since=0'))).toEqual([
      'second',
      'rejected',
      'noop',
      'initial',
    ]);
    // since > 0 stays a window over domain events: operations without events
    // are not part of it.
    expect(ids(await list(f, '?since=1'))).toEqual(['second']);
    expect(ids(await list(f, '?until=1'))).toEqual([
      'rejected',
      'noop',
      'initial',
    ]);
    expect(ids(await list(f, '?after=0&actor=owner'))).toEqual([
      'initial',
      'noop',
      'rejected',
      'second',
    ]);
    const stored = (await (
      await f.app.request('/api/operations/rejected')
    ).json()) as Summary;
    expect(stored.operationSeq).toBe(3);
    f.close();
  });
  it('a write between pages neither skips nor duplicates operations when the client advances after=', async () => {
    const f = fixture();
    for (const id of ['a', 'b', 'c', 'd'])
      success(
        await f.post(
          {
            command: 'task.create',
            payload: { id, area: 'agency', title: id },
          },
          { id: `op-${id}` },
        ),
      );
    const first = await list(f, '?after=0&limit=2');
    expect(ids(first)).toEqual(['op-a', 'op-b']);
    success(
      await f.post(
        {
          command: 'task.create',
          payload: { id: 'e', area: 'agency', title: 'e' },
        },
        { id: 'op-e' },
      ),
    );
    const second = await list(
      f,
      `?after=${first.items.at(-1)!.operationSeq}&limit=2`,
    );
    expect(ids(second)).toEqual(['op-c', 'op-d']);
    const third = await list(
      f,
      `?after=${second.items.at(-1)!.operationSeq}&limit=2`,
    );
    expect(ids(third)).toEqual(['op-e']);
    expect(third.more).toBe(false);
    f.close();
  });
  it('digest accepts sinceOp, reports operationSeq next to seq and shows no-op and rejected operations', async () => {
    const f = fixture();
    success(
      await f.post(
        {
          command: 'task.create',
          payload: { id: 'existing', area: 'agency', title: 'Initial' },
        },
        { id: 'initial' },
      ),
    );
    success(
      await f.post(
        {
          command: 'task.update',
          payload: { id: 'existing', baseRevision: 1, title: 'Initial' },
        },
        { id: 'no-effect' },
      ),
    );
    const rejected = await f.post(
      {
        command: 'task.create',
        payload: { id: 'existing', area: 'agency', title: 'Duplicate ID' },
      },
      { id: 'rejected' },
    );
    expect(rejected.status).toBe(409);
    type Digest = {
      seq: number;
      operationSeq: number;
      operations: { items: Summary[]; href: string };
    };
    const digest = async (query: string) =>
      (await (await f.app.request(`/api/digest${query}`)).json()) as Digest;
    // Astra probe digest-and-since-exclude-no-event-operations: all three ids.
    const all = await digest('?since=0');
    expect(all.operations.items.map((i) => i.id)).toEqual([
      'rejected',
      'no-effect',
      'initial',
    ]);
    expect(all.seq).toBe(1);
    expect(all.operationSeq).toBe(3);
    expect((await digest('')).operations.items.map((i) => i.id)).toEqual([
      'rejected',
      'no-effect',
      'initial',
    ]);
    // sinceOp is the first page of the journal behind href (after=1): the
    // operations in journal order, so href + nextCursor continues it.
    const tail = await digest('?sinceOp=1');
    expect(tail.operations.items.map((i) => i.id)).toEqual([
      'no-effect',
      'rejected',
    ]);
    expect(tail.operations.href).toContain('after=1');
    expect((await digest('?sinceOp=3')).operations.items).toEqual([]);
    // since > 0 keeps the event window: nothing after event 1.
    expect((await digest('?since=1')).operations.items).toEqual([]);
    f.close();
  });
  it('export and import keep operationSeq; a repeated envelope after import does not take a new position', async () => {
    const source = fixture();
    success(
      await source.post(
        {
          command: 'task.create',
          payload: { id: 't', area: 'agency', title: 'T' },
        },
        { id: 'op-1' },
      ),
    );
    const rejected = await source.post(
      {
        command: 'task.create',
        payload: { id: 't', area: 'agency', title: 'T' },
      },
      { id: 'op-2' },
    );
    expect(rejected.status).toBe(409);
    success(
      await source.post(
        {
          command: 'task.update',
          payload: { id: 't', baseRevision: 1, note: 'n' },
        },
        { id: 'op-3' },
      ),
    );
    const data = exportWorkspace(source.db);
    expect(data.operations.map((o) => [o.id, o.operationSeq])).toEqual([
      ['op-1', 1],
      ['op-2', 2],
      ['op-3', 3],
    ]);
    const target = openDatabase(':memory:');
    migrate(target);
    importWorkspace(target, data);
    expect(readOperations(target).map((o) => [o.id, o.operationSeq])).toEqual([
      ['op-1', 1],
      ['op-2', 2],
      ['op-3', 3],
    ]);
    target.close();
    source.close();
  });
});
describe('TI-009 domain rejections after the envelope is accepted are stored', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => ({
    id: `step-${i}`,
    text: `Step ${i}`,
    done: false,
  }));
  it('invariant-rejection-is-not-idempotently-recorded: the 101st step is a stored 400, repeat is identical, another payload is a mismatch', async () => {
    const f = fixture();
    success(
      await f.post({
        command: 'task.create',
        payload: {
          id: 'checklist-limit',
          title: 'Checklist limit',
          area: 'agency',
          checklist: hundred,
        },
      }),
    );
    const add = {
      command: 'checklist.add' as const,
      payload: {
        taskId: 'checklist-limit',
        baseRevision: 1,
        id: 'step-101',
        text: 'Exceeds limit',
      },
    };
    const failed = await f.post(add, { id: 'invariant-rejection' });
    expect(failed.status).toBe(400);
    expect(failed.body).toMatchObject({
      ok: false,
      code: 'invalid',
      retryable: false,
      operationId: 'invariant-rejection',
    });
    const stored = await f.app.request('/api/operations/invariant-rejection');
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({
      id: 'invariant-rejection',
      status: 400,
      ok: false,
      errorCode: 'invalid',
      result: failed.body,
    });
    const repeat = await f.post(add, { id: 'invariant-rejection' });
    expect(repeat.status).toBe(400);
    expect(repeat.body).toEqual(failed.body);
    const reused = await f.post(
      {
        command: 'task.update',
        payload: {
          id: 'checklist-limit',
          baseRevision: 1,
          title: 'Different command reused rejected ID',
        },
      },
      { id: 'invariant-rejection' },
    );
    expect(reused.status).toBe(409);
    expect((reused.body as OperationError).code).toBe('operation_mismatch');
    expect(f.state().tasks[0]!.checklist).toHaveLength(100);
    expect(f.state().tasks[0]!.title).toBe('Checklist limit');
    f.close();
  });
  it('a step id already used in the task takes the same stored path', async () => {
    const f = fixture();
    success(
      await f.post({
        command: 'task.create',
        payload: {
          id: 't1',
          area: 'agency',
          title: 'T',
          checklist: [{ id: 'step-a', text: 'A', done: false }],
        },
      }),
    );
    const dup = await f.post(
      {
        command: 'checklist.add',
        payload: { taskId: 't1', baseRevision: 1, id: 'step-a', text: 'dup' },
      },
      { id: 'dup-step' },
    );
    // 0008: a step is a record, a taken id is a conflict like a task's.
    expect(dup.status).toBe(409);
    expect((dup.body as OperationError).code).toBe('conflict');
    expect((await f.app.request('/api/operations/dup-step')).status).toBe(200);
    const reuse = await f.post(
      {
        command: 'task.update',
        payload: { id: 't1', baseRevision: 1, title: 'reused id' },
      },
      { id: 'dup-step' },
    );
    expect(reuse.status).toBe(409);
    f.close();
  });
  it('a violation in the second command of a batch reports commandIndex 1, is stored and leaves the state untouched', async () => {
    const f = fixture();
    success(
      await f.post({
        command: 'task.create',
        payload: {
          id: 'full',
          title: 'Full',
          area: 'agency',
          checklist: hundred,
        },
      }),
    );
    const before = f.state();
    const result = await f.batch(
      [
        {
          command: 'task.update',
          payload: { id: 'full', baseRevision: 1, note: 'changed' },
        },
        {
          command: 'checklist.add',
          payload: { taskId: 'full', baseRevision: 1, text: 'one more' },
        },
      ],
      { id: 'batch-invariant' },
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'invalid', commandIndex: 1 });
    expect(f.state()).toEqual(before);
    expect(
      (await f.app.request('/api/operations/batch-invariant')).status,
    ).toBe(200);
    f.close();
  });
});
