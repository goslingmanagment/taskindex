import { describe, expect, it } from 'vitest';
import { defaultAppearance } from '../../src/shared/domain-schemas';
import type { DomainEvent, OperationSuccess } from '../../src/shared/model';
import { WorkspaceStore } from '../../src/web/app/store';
import { createFrameSubscription } from '../../src/web/app/frame-subscription';
import { makeTask } from './fixtures';

function harness(store = new WorkspaceStore()) {
  store.loadSnapshot({
    generation: 'g',
    seq: 0,
    schemaVersion: 4,
    today: '2026-09-12',
    timezone: 'UTC',
    projects: [],
    labels: [],
    appearance: defaultAppearance(),
    tasks: [
      makeTask({
        id: 't',
        area: 'agency',
        title: 'Initial',
        revision: 1,
        orderKey: 'a0',
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:00.000Z',
      }),
    ],
  });
  let nextFrame = 0,
    upstreamSubscriptions = 0;
  const frames = new Map<number, () => void>();
  const canceled: number[] = [];
  const subscribe = createFrameSubscription(
    {
      getSnapshot: store.getSnapshot,
      subscribe: (listener) => {
        upstreamSubscriptions++;
        const off = store.subscribe(listener);
        return () => {
          upstreamSubscriptions--;
          off();
        };
      },
    },
    {
      request(callback) {
        const id = nextFrame++;
        frames.set(id, callback);
        return id;
      },
      cancel(id) {
        canceled.push(id);
        frames.delete(id);
      },
    },
  );
  const ingest = (seq: number) => {
    const event: DomainEvent = {
      generation: store.getSnapshot().generation,
      seq,
      firstSeq: seq,
      lastSeq: seq,
      operationId: `op${seq}`,
      actorId: 'agent:a',
      actorLabel: 'A',
      at: '2026-09-12T12:00:00.000Z',
      command: 'task.update',
      entityKind: 'task',
      entityId: 't',
      recordRevision: seq + 1,
      changes: {
        title: {
          from: seq === 1 ? 'Initial' : `Title ${seq - 1}`,
          to: `Title ${seq}`,
        },
      },
    };
    store.ingest([event]);
  };
  const flush = () => {
    const ready = [...frames];
    frames.clear();
    for (const [, callback] of ready) callback();
  };
  return {
    store,
    subscribe,
    ingest,
    flush,
    frames,
    canceled,
    upstream: () => upstreamSubscriptions,
  };
}

describe('TI-083 opt-in board frame subscription', () => {
  it('coalesces 100 board notifications while sync consumers observe every committed position', () => {
    const h = harness();
    const synchronous: number[] = [],
      first: number[] = [],
      second: number[] = [];
    const raw = h.store.subscribe(() =>
      synchronous.push(h.store.getSnapshot().seq),
    );
    const off1 = h.subscribe(() => first.push(h.store.getSnapshot().seq));
    const off2 = h.subscribe(() => second.push(h.store.getSnapshot().seq));
    for (let seq = 1; seq <= 100; seq++) h.ingest(seq);
    expect(synchronous).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(h.store.getSnapshot().data.tasks[0]!.title).toBe('Title 100');
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(h.frames.size).toBe(1);
    expect(h.upstream()).toBe(1);
    h.flush();
    expect(first).toEqual([100]);
    expect(second).toEqual([100]);
    expect(h.frames.size).toBe(0);
    raw();
    off1();
    off2();
    expect(h.upstream()).toBe(0);
  });

  it('cancels the last listener including frame handle zero and starts cleanly on resubscribe', () => {
    const h = harness();
    const seen: number[] = [];
    const off = h.subscribe(() => seen.push(h.store.getSnapshot().seq));
    h.ingest(1);
    off();
    expect(h.canceled).toEqual([0]);
    expect(h.frames.size).toBe(0);
    expect(h.upstream()).toBe(0);
    h.ingest(2);
    h.flush();
    expect(seen).toEqual([]);
    const stop = h.subscribe(() => seen.push(h.store.getSnapshot().seq));
    h.ingest(3);
    h.flush();
    expect(seen).toEqual([3]);
    stop();
  });

  it('keeps a pending frame for remaining listeners and never calls an unsubscribed one', () => {
    const h = harness();
    const seen: string[] = [];
    const off1 = h.subscribe(() => seen.push('first'));
    const off2 = h.subscribe(() => seen.push('second'));
    h.ingest(1);
    off1();
    expect(h.canceled).toEqual([]);
    h.flush();
    expect(seen).toEqual(['second']);
    off2();
  });

  it('schedules updates raised during notification for the next frame without losing them', () => {
    const h = harness();
    const seen: number[] = [];
    const stop = h.subscribe(() => {
      const seq = h.store.getSnapshot().seq;
      seen.push(seq);
      if (seq === 1) h.ingest(2);
    });
    h.ingest(1);
    h.flush();
    expect(seen).toEqual([1]);
    expect(h.store.getSnapshot().seq).toBe(2);
    expect(h.frames.size).toBe(1);
    h.flush();
    expect(seen).toEqual([1, 2]);
    stop();
  });

  it('keeps immediate state and synchronous connection edges while a hidden tab does not run frames', () => {
    const h = harness();
    const edges: boolean[] = [],
      board: number[] = [];
    const raw = h.store.subscribe(() =>
      edges.push(h.store.getSnapshot().connected),
    );
    const stop = h.subscribe(() => board.push(h.store.getSnapshot().seq));
    h.store.setConnected(true);
    h.store.setConnected(false);
    h.ingest(1);
    h.store.setConnected(true);
    expect(h.store.getSnapshot().seq).toBe(1);
    expect(edges).toEqual([true, false, false, true]);
    expect(board).toEqual([0, 0, 1]);
    h.flush();
    expect(board).toEqual([0, 0, 1]);
    raw();
    stop();
  });

  it('flushes generation control immediately and cancels an old frame before new normal updates', () => {
    const h = harness();
    const seen: string[] = [];
    const stop = h.subscribe(() => {
      const current = h.store.getSnapshot();
      seen.push(`${current.generation}/${current.seq}`);
    });
    h.ingest(1);
    h.store.loadSnapshot({
      generation: 'restored',
      seq: 0,
      schemaVersion: 4,
      today: '2026-09-12',
      timezone: 'UTC',
      labels: [],
      projects: [],
      appearance: defaultAppearance(),
      tasks: [
        makeTask({ id: 't', area: 'agency', title: 'Restored', revision: 1 }),
      ],
    });
    expect(seen).toEqual(['restored/0']);
    expect(h.canceled).toEqual([0]);
    expect(h.frames.size).toBe(0);
    h.ingest(1);
    expect(seen).toEqual(['restored/0']);
    h.flush();
    expect(seen).toEqual(['restored/0', 'restored/1']);
    stop();
    expect(h.upstream()).toBe(0);
  });

  it('notifies pending and ACK immediately but ignores an equal pending array rebuilt by foreign events', async () => {
    const rows = new Map<string, string>();
    let resolve!: (result: OperationSuccess) => void;
    const store = new WorkspaceStore(
      async <T>() =>
        new Promise<T>((done) => {
          resolve = (result) => done(result as T);
        }),
      {
        get length() {
          return rows.size;
        },
        key: (i) => [...rows.keys()][i] ?? null,
        getItem: (key) => rows.get(key) ?? null,
        setItem: (key, value) => {
          rows.set(key, value);
        },
        removeItem: (key) => {
          rows.delete(key);
        },
      },
    );
    const h = harness(store);
    const seen: string[][] = [];
    const stop = h.subscribe(() =>
      seen.push(store.getSnapshot().pending.map((p) => p.status)),
    );
    const pending = store.submit(
      {
        command: 'task.update',
        payload: { id: 't', baseRevision: 1, note: 'Owner note' },
      },
      'owner-op',
    );
    expect(seen.at(-1)).toEqual(['sending']);
    expect(rows.size).toBe(1);
    const notified = seen.length;
    h.ingest(1);
    expect(seen).toHaveLength(notified);
    expect(store.getSnapshot().seq).toBe(1);
    expect(h.frames.size).toBe(1);
    const event: DomainEvent = {
      generation: 'g',
      seq: 2,
      firstSeq: 2,
      lastSeq: 2,
      operationId: 'owner-op',
      actorId: 'owner',
      actorLabel: 'Owner',
      at: '2026-09-12T12:00:00.000Z',
      command: 'task.update',
      entityKind: 'task',
      entityId: 't',
      recordRevision: 3,
      changes: { note: { from: '', to: 'Owner note' } },
    };
    resolve({
      ok: true,
      operationId: 'owner-op',
      generation: 'g',
      firstSeq: 2,
      lastSeq: 2,
      events: [event],
      results: [],
    });
    await pending;
    expect(seen).toContainEqual(['acked']);
    expect(seen.at(-1)).toEqual([]);
    expect(h.frames.size).toBe(0);
    expect(rows.size).toBe(0);
    expect(store.getSnapshot().data.tasks[0]!.note).toBe('Owner note');
    stop();
  });
});
