import { describe, expect, it } from 'vitest';
import type { DomainEvent, Snapshot } from '../../src/shared/model';
import { WorkspaceStore } from '../../src/web/app/store';
import { ApiError } from '../../src/web/app/api';
import {
  startSync,
  SSE_RECONNECT_MAX_MS,
  RESYNC_INTERVAL_MS,
  type SyncDeps,
} from '../../src/web/app/sync';
import { makeTask } from '../../src/web/lib/workspace';

// TI-043: a CLOSED EventSource is recreated with backoff; 401/403 and `revoked` stop it.
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  fail(final: boolean) {
    this.readyState = final ? 2 : 0;
    this.onerror?.(new Event('error'));
  }
  message(data: unknown) {
    this.onmessage?.({
      data: typeof data === 'string' ? data : JSON.stringify(data),
    } as MessageEvent);
  }
  dispatch(type: string, data = '{}') {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ data } as MessageEvent);
  }
}
class MemoryStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}
const snapshot = (generation = 'gen1', seq = 0): Snapshot => ({
  generation,
  seq,
  today: '2026-09-08',
  timezone: 'Europe/Moscow',
  projects: [],
  tasks: [
    makeTask({
      id: 'task1',
      area: 'agency',
      title: 'Исходное',
      revision: 1,
      orderKey: 'a0',
    }),
  ],
});
const event = (seq: number): DomainEvent => ({
  seq,
  generation: 'gen1',
  at: '2026-09-08T01:00:00Z',
  actorId: 'owner',
  actorLabel: 'Владелец',
  operationId: `op${seq}`,
  entityKind: 'task',
  entityId: 'task1',
  command: 'task.update',
  changes: { title: { from: 'Исходное', to: `Название ${seq}` } },
  recordRevision: seq + 1,
  firstSeq: seq,
  lastSeq: seq,
});
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function harness(options: { me?: () => Promise<unknown> } = {}) {
  FakeEventSource.instances = [];
  const paths: string[] = [];
  let generation = 'gen1';
  const store = new WorkspaceStore(async <T>(path: string): Promise<T> => {
    paths.push(path);
    if (path === '/api/snapshot') return snapshot(generation) as T;
    if (path === '/api/me') {
      if (options.me) return (await options.me()) as T;
      return {
        id: 'owner',
        label: 'Владелец',
        kind: 'owner',
        scope: 'write',
      } as T;
    }
    return { generation, events: [], latestSeq: 0, more: false } as T;
  }, new MemoryStorage());
  const timeouts: { fn: () => void; ms: number }[] = [];
  const intervals: { fn: () => void; ms: number }[] = [];
  const listeners = new Map<string, () => void>();
  const deps: SyncDeps = {
    EventSource: FakeEventSource as unknown as typeof EventSource,
    setTimeout: (fn, ms) => {
      timeouts.push({ fn, ms });
      return timeouts.length;
    },
    clearTimeout: (id) => {
      if (typeof id === 'number')
        timeouts.splice(id - 1, 1, { fn: () => {}, ms: -1 });
    },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval: (id) => {
      if (typeof id === 'number')
        intervals.splice(id - 1, 1, { fn: () => {}, ms: -1 });
    },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    request: store['transport'] as SyncDeps['request'],
  };
  const stop = startSync(store, deps);
  const runTimeouts = async () => {
    const due = timeouts.splice(0).filter((t) => t.ms >= 0);
    for (const t of due) t.fn();
    await flush();
  };
  return {
    store,
    paths,
    timeouts,
    intervals,
    listeners,
    stop,
    runTimeouts,
    setGeneration: (value: string) => {
      generation = value;
    },
    get streams() {
      return FakeEventSource.instances;
    },
    get stream() {
      return FakeEventSource.instances.at(-1)!;
    },
  };
}
describe('startSync reconnects a closed EventSource', () => {
  it('marks the store connected and reconciles operations on open', async () => {
    const h = harness();
    await flush();
    expect(h.streams).toHaveLength(1);
    expect(h.stream.url).toContain('generation=gen1');
    const before = h.store.getSnapshot().operationsVersion;
    h.stream.open();
    expect(h.store.getSnapshot().connected).toBe(true);
    expect(h.store.getSnapshot().operationsVersion).toBe(before + 1);
  });
  it('leaves a CONNECTING stream to the browser but recreates a CLOSED one with backoff', async () => {
    const h = harness();
    await flush();
    h.stream.open();
    h.stream.fail(false);
    expect(h.store.getSnapshot().connected).toBe(false);
    expect(h.streams).toHaveLength(1);
    expect(h.timeouts.filter((t) => t.ms >= 0)).toHaveLength(0);
    const delays: number[] = [];
    const meBefore = h.paths.filter((p) => p === '/api/me').length;
    for (let attempt = 0; attempt < 6; attempt++) {
      h.stream.fail(true);
      const pending = h.timeouts.filter((t) => t.ms >= 0);
      expect(pending).toHaveLength(1);
      delays.push(pending[0]!.ms);
      expect(h.streams).toHaveLength(attempt + 1);
      await h.runTimeouts();
      expect(h.streams).toHaveLength(attempt + 2);
    }
    expect(delays).toEqual([
      1000,
      2000,
      4000,
      8000,
      16000,
      SSE_RECONNECT_MAX_MS,
    ]);
    expect(h.paths.filter((p) => p === '/api/me')).toHaveLength(meBefore + 6);
    h.stream.open();
    h.stream.fail(true);
    expect(h.timeouts.filter((t) => t.ms >= 0)[0]!.ms).toBe(1000);
  });
  it('stops reconnecting once /api/me answers 401 or 403 and reports the revoked access', async () => {
    const h = harness({
      me: async () => {
        throw new ApiError(
          {
            ok: false,
            code: 'unauthorized',
            retryable: false,
            message: 'Нет доступа',
          },
          401,
        );
      },
    });
    await flush();
    h.stream.open();
    h.stream.fail(true);
    await h.runTimeouts();
    expect(h.streams).toHaveLength(1);
    expect(h.timeouts.filter((t) => t.ms >= 0)).toHaveLength(0);
    expect(h.store.getSnapshot().revoked).toBe(true);
    expect(h.store.getSnapshot().connected).toBe(false);
    for (const interval of h.intervals) interval.fn();
    await flush();
    expect(h.streams).toHaveLength(1);
  });
  it('treats the revoked event as final: no reconnect loop, state shows revoked access', async () => {
    const h = harness();
    await flush();
    h.stream.open();
    h.stream.dispatch('revoked');
    expect(h.stream.readyState).toBe(FakeEventSource.CLOSED);
    expect(h.store.getSnapshot().revoked).toBe(true);
    expect(h.timeouts.filter((t) => t.ms >= 0)).toHaveLength(0);
    h.store.setConnected(false);
    for (const interval of h.intervals) interval.fn();
    await flush();
    expect(h.streams).toHaveLength(1);
  });
  it('ingests messages, catches up on invalid JSON and resyncs on reset', async () => {
    const h = harness();
    await flush();
    h.stream.open();
    h.stream.message(event(1));
    expect(h.store.getSnapshot().seq).toBe(1);
    h.stream.message('{not json');
    await flush();
    expect(h.paths.some((p) => p.startsWith('/api/events?'))).toBe(true);
    h.setGeneration('gen2');
    const count = h.streams.length;
    h.stream.dispatch('reset', '{"generation":"gen2"}');
    await flush();
    expect(h.store.getSnapshot().generation).toBe('gen2');
    expect(h.streams).toHaveLength(count + 1);
    expect(h.stream.url).toContain('generation=gen2');
  });
  it('the minute timer catches up and reconnects when no stream is alive', async () => {
    const h = harness();
    await flush();
    expect(h.intervals[0]!.ms).toBe(RESYNC_INTERVAL_MS);
    h.stream.open();
    h.stream.fail(true);
    const pending = h.timeouts.filter((t) => t.ms >= 0);
    expect(pending).toHaveLength(1);
    // The timer ticks while a reconnect is scheduled: it must not open a duplicate.
    h.intervals[0]!.fn();
    await flush();
    expect(h.streams).toHaveLength(1);
    await h.runTimeouts();
    expect(h.streams).toHaveLength(2);
    h.stream.open();
    expect(h.store.getSnapshot().connected).toBe(true);
    h.stop();
    expect(h.stream.readyState).toBe(FakeEventSource.CLOSED);
    expect(h.intervals.every((i) => i.ms < 0)).toBe(true);
  });
});
