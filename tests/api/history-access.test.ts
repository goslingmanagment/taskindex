import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  openDatabase,
  migrate,
  readEventsForRecord,
  readEventsForOperation,
  readEventBySeq,
  readTaskByOrigin,
  readComments,
  readOperationsPage,
  serverHistory,
} from '../../src/server/db.js';
import { executeOperation } from '../../src/server/operations.js';
import type { Command, DomainEvent } from '../../src/shared/model.js';
import { owner, fixture, success } from './helpers.js';
import { generation } from '../../src/server/db.js';

// Plan 01, tests 1 and 2: the reducer's three selections over the journal are
// answered by indexed queries, and the overlay of the current packet is part
// of the answer.
const op = (name: string) => `0000-0000-0000-0000-${name}` as const;
function setup() {
  const db = openDatabase(':memory:');
  migrate(db);
  const run = (command: Command, name: string = randomUUID()) => {
    const id = op(name);
    const r = executeOperation(
      db,
      { ...command, operationId: id, generation: generation(db) },
      owner,
    );
    if (!r.body.ok) throw new Error(JSON.stringify(r.body));
    return r.body;
  };
  return { db, run };
}
const plan = (db: ReturnType<typeof openDatabase>, sql: string) =>
  (db.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
    .map((r) => r.detail)
    .join('\n');
describe('history access (plan 01, phase 1)', () => {
  it('reads record history, operation events, origin lookups, comments and operation pages through their indexes', () => {
    const { db } = setup();
    expect(
      plan(
        db,
        "SELECT * FROM events WHERE entity_kind='task' AND entity_id='t' AND record_revision>0 ORDER BY seq",
      ),
    ).toContain('events_entity_revision');
    expect(
      plan(db, "SELECT * FROM events WHERE operation_id='op' ORDER BY seq"),
    ).toContain('events_operation');
    expect(
      plan(
        db,
        "SELECT id FROM tasks WHERE origin_system='github' AND origin_ref='1'",
      ),
    ).toContain('tasks_origin');
    expect(
      plan(
        db,
        "SELECT * FROM comments WHERE task_id='t' AND (created_at>'a' OR (created_at='a' AND id>'c')) ORDER BY created_at, id LIMIT 3",
      ),
    ).toContain('comments_task_created');
    expect(
      plan(
        db,
        'SELECT * FROM operations WHERE operation_seq>5 ORDER BY operation_seq LIMIT 3',
      ),
    ).toContain('operations_seq');
    db.close();
  });
  it('serverHistory merges the journal with the overlay of the current packet under the same conditions', () => {
    const { db, run } = setup();
    run(
      {
        command: 'task.create',
        payload: { id: 't', area: 'agency', title: 'T' },
      },
      'create',
    );
    run(
      {
        command: 'task.update',
        payload: { id: 't', baseRevision: 1, note: 'one' },
      },
      'first',
    );
    run(
      {
        command: 'task.update',
        payload: { id: 't', baseRevision: 2, note: 'two' },
      },
      'second',
    );
    const stored = readEventsForRecord(db, 'task', 't', 0);
    expect(stored.map((e) => [e.seq, e.recordRevision])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(readEventsForRecord(db, 'task', 't', 2).map((e) => e.seq)).toEqual([
      3,
    ]);
    expect(readEventsForOperation(db, op('second')).map((e) => e.seq)).toEqual([
      3,
    ]);
    expect(readEventBySeq(db, 2)?.operationId).toBe(op('first'));
    expect(readEventBySeq(db, 9)).toBeUndefined();
    const overlay: DomainEvent[] = [
      {
        ...stored[2]!,
        seq: 4,
        operationId: 'packet',
        recordRevision: 4,
        changes: { note: { from: 'two', to: 'three' } },
      },
      {
        ...stored[2]!,
        seq: 5,
        operationId: 'packet',
        entityId: 'other',
        recordRevision: 1,
        changes: { title: { from: null, to: 'Other' } },
      },
    ];
    const history = serverHistory(db, overlay);
    expect(history.forRecord('task', 't', 2).map((e) => e.seq)).toEqual([3, 4]);
    expect(history.forRecord('task', 't', 3).map((e) => e.seq)).toEqual([4]);
    expect(history.forRecord('task', 'other', 0).map((e) => e.seq)).toEqual([
      5,
    ]);
    expect(history.forOperation('packet').map((e) => e.seq)).toEqual([4, 5]);
    expect(history.forOperation(op('first')).map((e) => e.seq)).toEqual([2]);
    expect(history.bySeq(4)?.operationId).toBe('packet');
    expect(history.bySeq(1)?.operationId).toBe(op('create'));
    expect(history.bySeq(7)).toBeUndefined();
    db.close();
  });
  it('point reads answer by origin and comment keyset, and operation pages honour actor, window and cursor', async () => {
    const f = fixture();
    success(
      await f.post(
        {
          command: 'task.create',
          payload: {
            id: 't',
            area: 'agency',
            title: 'T',
            origin: { system: 'github', ref: '1' },
          },
        },
        { id: 'op-create' },
      ),
    );
    for (const n of [1, 2, 3])
      success(
        await f.post(
          {
            command: 'comment.add',
            payload: { id: `c${n}`, taskId: 't', text: `Text ${n}` },
          },
          { id: `op-c${n}`, role: n === 2 ? 'agent' : 'owner' },
        ),
      );
    expect(readTaskByOrigin(f.db, 'github', '1')?.id).toBe('t');
    expect(readTaskByOrigin(f.db, 'github', '2')).toBeUndefined();
    // Same createdAt for every comment (frozen clock): the tie breaks by id.
    const first = readComments(f.db, 't', { limit: 2 });
    expect(first.map((c) => c.id)).toEqual(['c1', 'c2']);
    const rest = readComments(f.db, 't', {
      after: { createdAt: first[1]!.createdAt, id: 'c2' },
      limit: 2,
    });
    expect(rest.map((c) => c.id)).toEqual(['c3']);
    const all = readOperationsPage(f.db, { limit: 10 });
    expect(all.rows.map((o) => o.id)).toEqual([
      'op-c3',
      'op-c2',
      'op-c1',
      'op-create',
    ]);
    expect(all.more).toBe(false);
    expect(all.rows[0]).toMatchObject({ taskCount: 1, titles: ['T'] });
    const byAgent = readOperationsPage(f.db, {
      actor: 'agent:test-agent',
      limit: 10,
    });
    expect(byAgent.rows.map((o) => o.id)).toEqual(['op-c2']);
    const window = readOperationsPage(f.db, { since: 1, until: 3, limit: 1 });
    expect(window.rows.map((o) => o.id)).toEqual(['op-c2']);
    expect(window.more).toBe(true);
    const next = readOperationsPage(f.db, {
      since: 1,
      until: 3,
      limit: 1,
      cursor: { operationSeq: window.rows[0]!.operationSeq },
    });
    expect(next.rows.map((o) => o.id)).toEqual(['op-c1']);
    expect(next.more).toBe(false);
    const journal = readOperationsPage(f.db, { after: 1, limit: 2 });
    expect(journal.rows.map((o) => o.id)).toEqual(['op-c1', 'op-c2']);
    expect(journal.more).toBe(true);
    const journalNext = readOperationsPage(f.db, {
      after: 1,
      limit: 2,
      cursor: { operationSeq: journal.rows[1]!.operationSeq },
    });
    expect(journalNext.rows.map((o) => o.id)).toEqual(['op-c3']);
    f.close();
  });
});
