import { describe, it, expect } from 'vitest';
import type {
  DomainEvent,
  OperationSuccess,
  Snapshot,
  StoredOperation,
} from '../../src/shared/model';
import { WorkspaceStore } from '../../src/web/app/store';
import { ApiError } from '../../src/web/app/api';
import { makeTask } from '../../src/web/lib/workspace';
import { taskSaveCommand } from '../../src/web/lib/use-workspace';
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
const task = () =>
  makeTask({
    id: 'task1',
    area: 'agency',
    title: 'Исходное',
    revision: 1,
    orderKey: 'a0',
    createdAt: '2026-09-08T00:00:00Z',
    updatedAt: '2026-09-08T00:00:00Z',
  });
const snapshot = (): Snapshot => ({
  generation: 'gen1',
  seq: 0,
  today: '2026-09-08',
  timezone: 'Europe/Moscow',
  projects: [],
  tasks: [task()],
});
function event(
  seq: number,
  firstSeq = seq,
  lastSeq = seq,
  operationId = 'op1',
): DomainEvent {
  return {
    seq,
    generation: 'gen1',
    at: '2026-09-08T01:00:00Z',
    actorId: 'owner',
    actorLabel: 'Дмитрий',
    operationId,
    entityKind: 'task',
    entityId: 'task1',
    command: 'task.update',
    changes: { title: { from: 'Исходное', to: `Название ${seq}` } },
    recordRevision: seq + 1,
    firstSeq,
    lastSeq,
  };
}
const success = (
  events: DomainEvent[],
  operationId = 'op1',
): OperationSuccess => ({
  ok: true,
  operationId,
  generation: 'gen1',
  firstSeq: events[0]?.firstSeq ?? null,
  lastSeq: events.at(-1)?.lastSeq ?? null,
  results: [{ record: task(), changes: {} }],
  events,
});
const unavailable = () =>
  new ApiError(
    {
      ok: false,
      code: 'unavailable',
      message: 'Запись временно закрыта',
      retryable: true,
    },
    503,
  );
const noopPage = { generation: 'gen1', events: [], latestSeq: 0, more: false };
const spin = () => new Promise((resolve) => setTimeout(resolve, 0));
describe('ordered operation store', () => {
  it('applies a whole batch in one confirmed update and never removes pending on its first event', async () => {
    const storage = new MemoryStorage();
    let resolve!: (value: OperationSuccess) => void;
    const store = new WorkspaceStore(
      async <T>(path: string) =>
        path === '/api/commands'
          ? ((await new Promise<OperationSuccess>((r) => {
              resolve = r;
            })) as T)
          : (noopPage as T),
      storage,
    );
    store.loadSnapshot(snapshot());
    const confirmed: number[] = [];
    store.subscribe(() => confirmed.push(store.getSnapshot().seq));
    const submitted = store.submit(
      {
        command: 'task.update',
        payload: { id: 'task1', baseRevision: 1, title: 'Мой текст' },
      },
      'op1',
    );
    store.ingest([event(1, 1, 2)]);
    expect(store.getSnapshot().confirmed.tasks[0].title).toBe('Исходное');
    expect(store.getSnapshot().pending).toHaveLength(1);
    expect(storage.length).toBe(1);
    store.ingest([event(2, 1, 2)]);
    expect(store.getSnapshot().seq).toBe(2);
    expect(store.getSnapshot().pending).toHaveLength(0);
    expect(confirmed).not.toContain(1);
    resolve(success([event(1, 1, 2), event(2, 1, 2)]));
    await submitted;
    expect(store.getSnapshot().pending).toHaveLength(0);
    expect(storage.length).toBe(0);
    store.ingest([event(1, 1, 2), event(2, 1, 2)]);
    expect(store.getSnapshot().seq).toBe(2);
  });
  it('catches a gap before applying a later HTTP acknowledgment', async () => {
    const cursors: number[] = [];
    const store = new WorkspaceStore(async <T>(path: string) => {
      cursors.push(
        Number(new URL(path, 'http://localhost').searchParams.get('since')),
      );
      return {
        generation: 'gen1',
        events: [event(1, 1, 1, 'other')],
        more: false,
        latestSeq: 2,
      } as T;
    }, new MemoryStorage());
    store.loadSnapshot(snapshot());
    store.acknowledge(success([event(2)]));
    expect(store.getSnapshot().seq).toBe(0);
    await spin();
    expect(cursors).toEqual([0]);
    expect(store.getSnapshot().seq).toBe(2);
  });
  it('uses a received cursor while a batch spans several catch-up pages', async () => {
    const cursors: number[] = [];
    const store = new WorkspaceStore(async <T>(path: string) => {
      const since = Number(
        new URL(path, 'http://localhost').searchParams.get('since'),
      );
      cursors.push(since);
      return {
        generation: 'gen1',
        events: [event(since + 1, 1, 3)],
        more: since < 2,
        latestSeq: 3,
      } as T;
    }, new MemoryStorage());
    store.loadSnapshot(snapshot());
    const applied: number[] = [];
    store.subscribe(() => applied.push(store.getSnapshot().seq));
    await store.catchUp();
    expect(cursors).toEqual([0, 1, 2]);
    expect(applied).toEqual([3]);
  });
  it('settles a successful operation without events without moving the cursor', async () => {
    const storage = new MemoryStorage(),
      store = new WorkspaceStore(async <T>() => success([]) as T, storage);
    store.loadSnapshot(snapshot());
    await store.submit(
      {
        command: 'task.update',
        payload: { id: 'task1', baseRevision: 1, title: 'Исходное' },
      },
      'op1',
    );
    expect(store.getSnapshot().pending).toHaveLength(0);
    expect(store.getSnapshot().seq).toBe(0);
    expect(storage.length).toBe(0);
  });
  it('retries a retryable 503 with the identical persisted envelope and keeps unknown after exhaustion', async () => {
    const storage = new MemoryStorage(),
      bodies: string[] = [];
    const store = new WorkspaceStore(
      async <T>(_path: string, init?: RequestInit): Promise<T> => {
        bodies.push(typeof init?.body === 'string' ? init.body : '');
        throw unavailable();
      },
      storage,
      async () => {},
    );
    store.loadSnapshot(snapshot());
    await expect(
      store.submit(
        {
          command: 'task.update',
          payload: { id: 'task1', baseRevision: 1, note: 'Черновик' },
        },
        'op1',
      ),
    ).rejects.toThrow('временно');
    expect(bodies).toHaveLength(4);
    expect(new Set(bodies).size).toBe(1);
    expect(storage.getItem('taskindex/ops/op1')).toBe(bodies[0]);
    expect(store.getSnapshot().pending[0].status).toBe('unknown');
  });
  it('removes a definitive conflict but preserves the error current value', async () => {
    const current = { ...task(), title: 'Чужое', revision: 2 };
    const storage = new MemoryStorage();
    const store = new WorkspaceStore(async <T>(): Promise<T> => {
      throw new ApiError(
        {
          ok: false,
          code: 'conflict',
          message: 'Конфликт',
          retryable: false,
          current,
        },
        409,
      );
    }, storage);
    store.loadSnapshot(snapshot());
    await expect(
      store.submit(
        {
          command: 'task.update',
          payload: { id: 'task1', baseRevision: 1, title: 'Моё' },
        },
        'op1',
      ),
    ).rejects.toMatchObject({ current });
    expect(store.getSnapshot().pending).toHaveLength(0);
    expect(store.getSnapshot().confirmed.tasks[0].title).toBe('Исходное');
    expect(storage.length).toBe(0);
  });
  it('reconciles a persisted operation after reload and does not resend a completed command', async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'taskindex/ops/op1',
      JSON.stringify({
        operationId: 'op1',
        generation: 'gen1',
        command: 'task.update',
        payload: { id: 'task1', baseRevision: 1, title: 'Название 1' },
      }),
    );
    const paths: string[] = [];
    const store = new WorkspaceStore(async <T>(path: string) => {
      paths.push(path);
      return {
        result: success([event(1)]),
        status: 200,
      } as StoredOperation as T;
    }, storage);
    store.loadSnapshot({
      ...snapshot(),
      seq: 1,
      tasks: [{ ...task(), title: 'Название 1', revision: 2 }],
    });
    await store.recover();
    expect(paths).toEqual(['/api/operations/op1']);
    expect(storage.length).toBe(0);
    expect(store.getSnapshot().pending).toHaveLength(0);
  });
  it('does not replay outbox envelopes across database generations', async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'taskindex/ops/op1',
      JSON.stringify({
        operationId: 'op1',
        generation: 'old',
        command: 'task.update',
        payload: { id: 'task1', baseRevision: 1, title: 'Старое' },
      }),
    );
    const store = new WorkspaceStore(async <T>(): Promise<T> => {
      throw new Error('Must not request');
    }, storage);
    store.loadSnapshot(snapshot());
    await store.recover();
    expect(store.getSnapshot().data.tasks[0].title).toBe('Исходное');
    await expect(store.retry('op1')).rejects.toThrow('прежней версии');
    expect(storage.length).toBe(1);
  });
  it('refuses to send a command when browser storage is unavailable (TI-006)', async () => {
    // Astra probe 03-storage-probe: the localStorage getter throws, browserStorage() is undefined.
    let postCount = 0;
    const store = new WorkspaceStore(
      async <T>(): Promise<T> => {
        postCount++;
        throw unavailable();
      },
      undefined,
      async () => {},
    );
    store.loadSnapshot(snapshot());
    expect(store.getSnapshot().storageAvailable).toBe(false);
    await expect(
      store.submit(
        {
          command: 'task.create',
          payload: { area: 'agency', title: 'Без конверта' },
        },
        'missing-storage-operation',
      ),
    ).rejects.toThrow('Хранилище браузера недоступно');
    expect(postCount).toBe(0);
    expect(store.getSnapshot().pending).toHaveLength(0);
    expect(store.getSnapshot().data.tasks).toHaveLength(1);
  });
  it('keeps optimistic entity identity and timestamps stable on unrelated store publishes', () => {
    const store = new WorkspaceStore(
      <T>() => new Promise<T>(() => {}),
      new MemoryStorage(),
    );
    store.loadSnapshot(snapshot());
    void store.submit(
      { command: 'task.create', payload: { area: 'agency', title: 'Новое' } },
      'op1',
    );
    expect(store.getSnapshot().data.tasks).toHaveLength(2);
    const before = structuredClone(store.getSnapshot().data.tasks);
    store.setConnected(true);
    store.setToday('2026-09-09');
    expect(store.getSnapshot().data.tasks).toEqual(before);
  });
  it('updates comment count without loading the lazy comment body and deduplicates additions', () => {
    const store = new WorkspaceStore(
      async <T>() => noopPage as T,
      new MemoryStorage(),
    );
    store.loadSnapshot({
      ...snapshot(),
      tasks: [{ ...task(), commentCount: 1 }],
    });
    const removed: DomainEvent = {
      ...event(1),
      entityKind: 'comment',
      entityId: 'comment1',
      taskId: 'task1',
      command: 'comment.remove',
      changes: { deletedAt: { from: null, to: '2026-09-08T01:00:00Z' } },
    };
    store.ingest([removed]);
    expect(store.getSnapshot().data.tasks[0].commentCount).toBe(0);
    const added: DomainEvent = {
      ...event(2),
      entityKind: 'comment',
      entityId: 'comment2',
      taskId: 'task1',
      command: 'comment.add',
      changes: {
        createdAt: { from: null, to: '2026-09-08T01:00:00Z' },
        deletedAt: { from: null, to: null },
        taskId: { from: null, to: 'task1' },
      },
    };
    store.ingest([added]);
    store.ingest([added]);
    expect(store.getSnapshot().data.tasks[0].commentCount).toBe(1);
  });
  it('sends only dirty editor fields in one atomic save', () => {
    const base = task(),
      draft = { ...base, note: 'Моя заметка' };
    expect(taskSaveCommand(draft, base)).toEqual({
      command: 'task.save',
      payload: {
        id: 'task1',
        baseRevision: 1,
        fields: { note: 'Моя заметка' },
      },
    });
    const command = taskSaveCommand(
      {
        ...draft,
        status: 'waiting',
        checklist: [{ id: 'step', text: 'Шаг', done: false }],
      },
      base,
    );
    expect(command.payload).toMatchObject({
      fields: { note: 'Моя заметка' },
      status: 'waiting',
      checklist: [{ id: 'step', text: 'Шаг', done: false }],
    });
  });
});
