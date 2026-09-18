import { afterEach, describe, it, expect, vi } from 'vitest';
import type {
  DomainEvent,
  OperationSuccess,
  Snapshot,
  StoredOperation,
} from '../../src/shared/model';
import { defaultAppearance } from '../../src/shared/domain-schemas';
import {
  SERVER_UPDATED_MESSAGE,
  WorkspaceStore,
} from '../../src/web/app/store';
import { ApiError, ContractMismatch, request } from '../../src/web/app/api';
import { makeTask } from './fixtures';
import { taskSaveCommand } from '../../src/web/app/commands';
import { draftChecklistItem } from '../../src/shared/steps';
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
  schemaVersion: 4,
  today: '2026-09-08',
  timezone: 'Europe/Moscow',
  projects: [],
  labels: [],
  steps: [],
  tasks: [task()],
  appearance: defaultAppearance(),
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
afterEach(() => vi.unstubAllGlobals());
describe('ordered operation store', () => {
  it('TI-086 preserves an incompatible successful write and reconciles it by GET after reload', async () => {
    const storage = new MemoryStorage();
    const id = 'op-contract';
    const applied = event(1, 1, 1, id);
    const result = success([applied], id);
    const paths: string[] = [];
    const envelopes: string[] = [];
    const known: StoredOperation = {
      id,
      operationSeq: 1,
      status: 200,
      ok: true,
      actorId: 'owner',
      actorLabel: 'Дмитрий',
      command: 'task.save',
      createdAt: applied.at,
      taskCount: 1,
      titles: ['Название 1'],
      firstSeq: 1,
      lastSeq: 1,
      result,
    };
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      paths.push(path);
      if (init?.method === 'POST') {
        if (typeof init.body !== 'string')
          throw new Error('Expected a JSON request body');
        envelopes.push(init.body);
        // The server applied the write, but this bundle cannot read its reply.
        return Response.json({ ...result, futureField: true });
      }
      return Response.json(known);
    });
    const store = new WorkspaceStore(request, storage);
    store.loadSnapshot(snapshot());
    const attempt = store.submit(
      taskSaveCommand({ ...task(), title: 'Название 1' }, task()),
      id,
    );
    await expect(attempt).rejects.toThrow('контракту');
    expect(store.getSnapshot().pending).toMatchObject([
      {
        envelope: { operationId: id },
        status: 'unknown',
        message: SERVER_UPDATED_MESSAGE,
      },
    ]);
    expect(store.getSnapshot().incompatible).toBe(true);
    expect(storage.getItem(`taskindex/ops/${id}`)).toBe(envelopes[0]);
    await expect(
      store.submit(
        taskSaveCommand({ ...task(), note: 'Ещё' }, task()),
        'op-next',
      ),
    ).rejects.toThrow(SERVER_UPDATED_MESSAGE);
    await expect(store.retry(id)).rejects.toThrow(SERVER_UPDATED_MESSAGE);
    expect(paths).toEqual(['/api/commands']);
    expect(storage.getItem('taskindex/ops/op-next')).toBeNull();

    const reloaded = new WorkspaceStore(request, storage);
    reloaded.loadSnapshot({
      ...snapshot(),
      schemaVersion: 5,
      seq: 1,
      tasks: [{ ...task(), title: 'Название 1', revision: 2 }],
    });
    await reloaded.recover();
    expect(paths).toEqual(['/api/commands', `/api/operations/${id}`]);
    expect(reloaded.getSnapshot().pending).toEqual([]);
    expect(reloaded.getSnapshot().confirmed.tasks[0]!.title).toBe('Название 1');
    expect(storage.getItem(`taskindex/ops/${id}`)).toBeNull();
  });

  it('TI-086 prevents recovery and manual retry from posting through an incompatible bundle', async () => {
    const storage = new MemoryStorage();
    const id = 'op-before-update';
    const envelope = {
      ...taskSaveCommand({ ...task(), title: 'Новое' }, task()),
      operationId: id,
      generation: 'gen1',
    };
    storage.setItem(`taskindex/ops/${id}`, JSON.stringify(envelope));
    const paths: string[] = [];
    const store = new WorkspaceStore(async <T>(path: string): Promise<T> => {
      paths.push(path);
      if (path === '/api/commands') return success([], id) as T;
      throw new ApiError(
        {
          ok: false,
          code: 'not_found',
          retryable: false,
          message: 'Операция неизвестна.',
        },
        404,
      );
    }, storage);
    store.loadSnapshot(snapshot());
    store.loadSnapshot({ ...snapshot(), schemaVersion: 5 });
    await store.recover();
    await spin();
    expect(paths).toEqual([`/api/operations/${id}`]);
    await expect(store.retry(id)).rejects.toThrow(SERVER_UPDATED_MESSAGE);
    expect(store.getSnapshot().pending).toMatchObject([
      { envelope, status: 'unknown', message: SERVER_UPDATED_MESSAGE },
    ]);
    expect(storage.getItem(`taskindex/ops/${id}`)).toBe(
      JSON.stringify(envelope),
    );
  });

  it('TI-086 marks an incompatible recovery reply unknown and stops writes', async () => {
    const storage = new MemoryStorage();
    const id = 'op-recover-contract';
    storage.setItem(
      `taskindex/ops/${id}`,
      JSON.stringify({
        ...taskSaveCommand({ ...task(), title: 'Новое' }, task()),
        operationId: id,
        generation: 'gen1',
      }),
    );
    vi.stubGlobal('fetch', async () => Response.json({ unexpected: true }));
    const store = new WorkspaceStore(request, storage);
    store.loadSnapshot(snapshot());
    await store.recover();
    expect(store.getSnapshot().incompatible).toBe(true);
    expect(store.getSnapshot().pending).toMatchObject([
      { status: 'unknown', message: SERVER_UPDATED_MESSAGE },
    ]);
    expect(storage.getItem(`taskindex/ops/${id}`)).not.toBeNull();
  });

  it('TI-086 stops a scheduled retry when another operation detects a contract change', async () => {
    const posts: string[] = [];
    const storage = new MemoryStorage();
    let resume!: () => void;
    vi.stubGlobal('fetch', async (_path: string, init?: RequestInit) => {
      if (typeof init?.body !== 'string')
        throw new Error('Expected a JSON request body');
      const { operationId } = JSON.parse(init.body) as {
        operationId: string;
      };
      posts.push(operationId);
      return operationId === 'op-backoff'
        ? Response.json(unavailable().detail, { status: 503 })
        : Response.json({ ...success([], operationId), futureField: true });
    });
    const store = new WorkspaceStore(
      request,
      storage,
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    store.loadSnapshot(snapshot());
    const first = store.submit(
      taskSaveCommand({ ...task(), title: 'Первое' }, task()),
      'op-backoff',
    );
    const rejected = expect(first).rejects.toThrow(SERVER_UPDATED_MESSAGE);
    await spin();
    await expect(
      store.submit(
        taskSaveCommand({ ...task(), note: 'Второе' }, task()),
        'op-contract-change',
      ),
    ).rejects.toBeInstanceOf(ContractMismatch);
    resume();
    await rejected;
    expect(posts).toEqual(['op-backoff', 'op-contract-change']);
    expect(store.getSnapshot().pending).toMatchObject([
      {
        envelope: { operationId: 'op-backoff' },
        status: 'unknown',
        message: SERVER_UPDATED_MESSAGE,
      },
      {
        envelope: { operationId: 'op-contract-change' },
        status: 'unknown',
        message: SERVER_UPDATED_MESSAGE,
      },
    ]);
    expect(storage.length).toBe(2);
  });

  it('TI-085 retains untouched records during optimistic writes and status publishes', () => {
    const store = new WorkspaceStore(
      <T>() => new Promise<T>(() => {}),
      new MemoryStorage(),
    );
    const untouched = { ...task(), id: 'untouched', orderKey: 'a1' };
    store.loadSnapshot({ ...snapshot(), tasks: [task(), untouched] });
    const before = store.getSnapshot().data;
    void store.submit(
      {
        command: 'task.update',
        payload: { id: 'task1', baseRevision: 1, title: 'Новое' },
      },
      'optimistic-change',
    );
    expect(store.getSnapshot().data.tasks[0]!.title).toBe('Новое');
    expect(store.getSnapshot().confirmed.tasks[0]!.title).toBe('Исходное');
    expect(store.getSnapshot().data.tasks[1]).toBe(before.tasks[1]);
    expect(store.getSnapshot().data.appearance).toBe(before.appearance);
    store.setConnected(true);
    expect(store.getSnapshot().data.tasks[1]).toBe(before.tasks[1]);
  });

  it('TI-085 optimistic comment effects update only their parent count and preserve confirmed state', () => {
    const store = new WorkspaceStore(
      <T>() => new Promise<T>(() => {}),
      new MemoryStorage(),
    );
    store.loadSnapshot({
      ...snapshot(),
      tasks: [task(), { ...task(), id: 'untouched', orderKey: 'a1' }],
    });
    const before = store.getSnapshot().data;
    void store.submit(
      {
        command: 'comment.add',
        payload: {
          id: 'comment-preview',
          taskId: 'task1',
          text: 'Комментарий',
        },
      },
      'optimistic-comment',
    );
    expect(store.getSnapshot().data.comments[0]!.text).toBe('Комментарий');
    expect(store.getSnapshot().data.tasks[0]!.commentCount).toBe(1);
    expect(store.getSnapshot().data.tasks[1]).toBe(before.tasks[1]);
    expect(before.tasks[0]!.commentCount).toBe(0);
    expect(before.comments).toHaveLength(0);
  });

  it('TI-085 discards every preview effect when a recovered batch has an invalid later command', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'taskindex/ops/invalid-batch',
      JSON.stringify({
        operationId: 'invalid-batch',
        generation: 'gen1',
        commands: [
          {
            command: 'task.update',
            payload: { id: 'task1', baseRevision: 1, title: 'Предварительное' },
          },
          {
            command: 'task.move',
            payload: { id: 'missing', baseRevision: 1, status: 'doing' },
          },
        ],
      }),
    );
    const store = new WorkspaceStore(
      <T>() => new Promise<T>(() => {}),
      storage,
    );
    store.loadSnapshot(snapshot());
    const before = store.getSnapshot().data;
    void store.recover();
    expect(store.getSnapshot().pending).toHaveLength(1);
    expect(store.getSnapshot().data).toBe(before);
    expect(store.getSnapshot().data.tasks[0]!.title).toBe('Исходное');
  });

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
    expect(store.getSnapshot().confirmed.tasks[0]!.title).toBe('Исходное');
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
      async <T>(
        _path: string,
        _schema: unknown,
        init?: RequestInit,
      ): Promise<T> => {
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
    expect(store.getSnapshot().pending[0]!.status).toBe('unknown');
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
    expect(store.getSnapshot().confirmed.tasks[0]!.title).toBe('Исходное');
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
  it('does not replay outbox envelopes across database generations and lets the owner dismiss them (TI-038)', async () => {
    // Fable repro store-foreign-pending: without dismiss the envelope survives every reload.
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
    expect(store.getSnapshot().data.tasks[0]!.title).toBe('Исходное');
    await expect(store.retry('op1')).rejects.toThrow('прежней версии');
    expect(storage.length).toBe(1);
    expect(store.getSnapshot().pending).toHaveLength(1);
    expect(store.getSnapshot().pending[0]!.message).toBe(
      'Изменение от прежней версии базы',
    );
    store.dismiss('op1');
    expect(store.getSnapshot().pending).toHaveLength(0);
    expect(storage.length).toBe(0);
    await store.recover();
    expect(store.getSnapshot().pending).toHaveLength(0);
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
  it('TI-003 a snapshot that arrives after a newer live event never rolls the state back', async () => {
    // Astra probe refresh-rolls-back-live-event: afterEvent {seq:1} must not become {seq:0}.
    let release!: (value: Snapshot) => void;
    const requests: string[] = [];
    const store = new WorkspaceStore(async <T>(path: string): Promise<T> => {
      requests.push(path);
      if (path === '/api/snapshot')
        return (await new Promise<Snapshot>((r) => {
          release = r;
        })) as T;
      return { ...noopPage, latestSeq: 1 } as T;
    }, new MemoryStorage());
    store.loadSnapshot(snapshot());
    store.setConnected(true);
    const refreshing = store.refresh();
    await spin();
    store.ingest([event(1)]);
    expect(store.getSnapshot().seq).toBe(1);
    expect(store.getSnapshot().confirmed.tasks[0]!.title).toBe('Название 1');
    release(snapshot());
    await refreshing;
    expect(store.getSnapshot().seq).toBe(1);
    expect(store.getSnapshot().confirmed.tasks[0]!.title).toBe('Название 1');
    expect(store.getSnapshot().loading).toBe(false);
    expect(requests.some((path) => path.includes('since=1'))).toBe(true);
  });
  it('TI-003 a refresh answered by the previous generation is discarded after a resync', async () => {
    const snapshots: ((value: Snapshot) => void)[] = [];
    const store = new WorkspaceStore(async <T>(path: string): Promise<T> => {
      if (path === '/api/snapshot')
        return (await new Promise<Snapshot>((r) => snapshots.push(r))) as T;
      return { ...noopPage, generation: 'gen2', latestSeq: 5 } as T;
    }, new MemoryStorage());
    store.loadSnapshot(snapshot());
    const stale = store.refresh();
    await spin();
    const fresh = store.resync();
    await spin();
    expect(snapshots).toHaveLength(2);
    snapshots[1]!({
      ...snapshot(),
      generation: 'gen2',
      seq: 5,
      tasks: [{ ...task(), title: 'Из новой базы', revision: 3 }],
    });
    await fresh;
    snapshots[0]!(snapshot());
    await stale;
    expect(store.getSnapshot().generation).toBe('gen2');
    expect(store.getSnapshot().seq).toBe(5);
    expect(store.getSnapshot().confirmed.tasks[0]!.title).toBe('Из новой базы');
    expect(store.getSnapshot().loading).toBe(false);
  });
  it('TI-074 previews are attributed to the actor from /api/me, as the confirmed record will be', async () => {
    const actor = {
      id: 'owner',
      label: 'Тестовый владелец',
      kind: 'owner' as const,
      scope: 'write' as const,
    };
    const store = new WorkspaceStore(async <T>(path: string): Promise<T> => {
      if (path === '/api/snapshot') return snapshot() as T;
      if (path === '/api/me') return actor as T;
      if (path === '/api/commands') return new Promise<T>(() => {});
      return noopPage as T;
    }, new MemoryStorage());
    await store.refresh();
    expect(store.getSnapshot().actor).toEqual(actor);
    void store.submit(
      { command: 'task.create', payload: { area: 'agency', title: 'Новое' } },
      'op1',
    );
    const preview = store
      .getSnapshot()
      .data.tasks.find((t) => t.title === 'Новое')!;
    expect(preview.createdBy).toBe('owner');
    expect(preview.createdByLabel).toBe('Тестовый владелец');
    const confirmed = makeTask(
      { id: preview.id, area: 'agency', title: 'Новое' },
      actor,
    );
    expect(confirmed.createdByLabel).toBe(preview.createdByLabel);
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
    expect(store.getSnapshot().data.tasks[0]!.commentCount).toBe(0);
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
    expect(store.getSnapshot().data.tasks[0]!.commentCount).toBe(1);
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
        checklist: [draftChecklistItem('step', 'Шаг')],
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

describe('план 04: связность ответа и версия схемы сервера', () => {
  it('не подтверждает конверт ответом от другой операции', async () => {
    const storage = new MemoryStorage();
    const store = new WorkspaceStore(
      async <T>(path: string) =>
        path === '/api/commands'
          ? (success([event(1)], 'чужой-id') as T)
          : (noopPage as T),
      storage,
    );
    store.loadSnapshot(snapshot());
    await expect(
      store.submit(
        {
          command: 'task.update',
          payload: { id: 'task1', baseRevision: 1, title: 'Мой текст' },
        },
        'op1',
      ),
    ).rejects.toThrow('Ответ относится к другой операции.');
    const pending = store.getSnapshot().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe('unknown');
    expect(pending[0]!.message).toBe('Ответ относится к другой операции');
    // Конверт остаётся в outbox: операция могла дойти до сервера.
    expect(storage.getItem('taskindex/ops/op1')).not.toBeNull();
  });
  it('останавливает отправку, когда сервер сменил версию схемы', async () => {
    const storage = new MemoryStorage();
    const store = new WorkspaceStore(async <T>() => noopPage as T, storage);
    store.loadSnapshot(snapshot());
    expect(store.getSnapshot().incompatible).toBe(false);
    store.loadSnapshot({ ...snapshot(), seq: 5, schemaVersion: 5 });
    expect(store.getSnapshot().incompatible).toBe(true);
    await expect(
      store.submit({
        command: 'task.update',
        payload: { id: 'task1', baseRevision: 1, title: 'Не уйдёт' },
      }),
    ).rejects.toThrow('Сервер обновлён');
    expect(storage.length).toBe(0);
    expect(store.getSnapshot().pending).toHaveLength(0);
  });
  it('уносит нечитаемый конверт в карантин вместо падения восстановления', async () => {
    const storage = new MemoryStorage();
    storage.setItem('taskindex/ops/broken', '{не json');
    storage.setItem('taskindex/ops/alien', JSON.stringify({ hello: 'world' }));
    const store = new WorkspaceStore(async <T>() => noopPage as T, storage);
    store.loadSnapshot(snapshot());
    await store.recover();
    expect(store.getSnapshot().pending).toHaveLength(0);
    expect(storage.getItem('taskindex/corrupt/taskindex/ops/broken')).toBe(
      '{не json',
    );
    expect(storage.getItem('taskindex/corrupt/taskindex/ops/alien')).toBe(
      JSON.stringify({ hello: 'world' }),
    );
    expect(storage.getItem('taskindex/ops/broken')).toBeNull();
  });
});
