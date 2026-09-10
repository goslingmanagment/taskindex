import type {
  Actor,
  Command,
  DomainEvent,
  EventsPage,
  OperationEnvelope,
  OperationSuccess,
  Snapshot,
  StoredOperation,
  WorkspaceState,
} from '@shared/model';
import { applyEvent, applyCommand } from '@shared/commands';
import { ApiError, request } from './api';
import { browserStorage, type StorageLike } from './drafts';
export type PendingOperation = {
  envelope: OperationEnvelope;
  status: 'sending' | 'unknown' | 'acked';
  previewTime: string;
  previewIds: string[];
  message?: string;
};
export type StoreState = {
  confirmed: WorkspaceState;
  data: WorkspaceState;
  generation: string;
  seq: number;
  today: string;
  timezone: string;
  pending: PendingOperation[];
  loading: boolean;
  error: string;
  connected: boolean;
  connectionFailed: boolean;
  lastEvents: DomainEvent[];
  operationsVersion: number;
  /** TI-006: without a durable outbox no command is sent; the UI shows a degradation banner. */
  storageAvailable: boolean;
  /** TI-043: the server revoked this session or key; the stream is not reopened. */
  revoked: boolean;
  /** TI-074: who this client acts as (`GET /api/me`); previews are attributed to it. */
  actor: Actor | null;
};
export const FALLBACK_ACTOR: Actor = {
  id: 'owner',
  label: 'Владелец',
  kind: 'owner',
  scope: 'write',
};
export const STORAGE_UNAVAILABLE_MESSAGE =
  'Хранилище браузера недоступно: изменения не отправляются. Скопируйте текст и повторите в обычном окне.';
type Transport = <T>(path: string, init?: RequestInit) => Promise<T>;
const empty = (): WorkspaceState => ({ projects: [], tasks: [], comments: [] });
const opKey = (id: string) => `taskindex/ops/${id}`;
export class WorkspaceStore {
  private state: StoreState = {
    confirmed: empty(),
    data: empty(),
    generation: '',
    seq: 0,
    today: '',
    timezone: 'Europe/Moscow',
    pending: [],
    loading: true,
    error: '',
    connected: false,
    connectionFailed: false,
    lastEvents: [],
    operationsVersion: 0,
    storageAvailable: true,
    revoked: false,
    actor: null,
  };
  private listeners = new Set<() => void>();
  private buffer = new Map<number, DomainEvent>();
  private flights = new Map<string, Promise<OperationSuccess>>();
  private catchingUp = false;
  private epoch = 0;
  private refreshFlight: Promise<void> | null = null;
  // TI-003: a refresh started before the server reported another generation is superseded.
  private refreshEpoch = 0;
  constructor(
    private transport: Transport = request,
    private storage: StorageLike | undefined = browserStorage(),
    private delay: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    this.state = { ...this.state, storageAvailable: storage !== undefined };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  private publish(patch: Partial<StoreState>) {
    this.state = { ...this.state, ...patch };
    let data = this.state.confirmed;
    for (const pending of this.state.pending) {
      if (pending.envelope.generation !== this.state.generation) continue;
      const commands =
        'commands' in pending.envelope
          ? pending.envelope.commands
          : [pending.envelope];
      let nextId = 0;
      try {
        let preview = data;
        for (const command of commands) {
          preview = applyCommand(
            preview,
            { command: command.command, payload: command.payload } as Command,
            {
              now: pending.previewTime,
              ids: () => {
                const index = nextId++;
                return (
                  pending.previewIds[index] ??
                  (pending.previewIds[index] = crypto.randomUUID())
                );
              },
              actor: this.state.actor ?? FALLBACK_ACTOR,
            },
          ).state;
        }
        data = preview;
      } catch {
        /* A failed preview leaves the complete operation unapplied. */
      }
    }

    this.state = { ...this.state, data };
    for (const listener of this.listeners) listener();
  }
  private persist(envelope: OperationEnvelope) {
    // Persist before sending: when storage rejects this write, no request is sent.
    if (!this.storage) throw new Error(STORAGE_UNAVAILABLE_MESSAGE);
    this.storage.setItem(opKey(envelope.operationId), JSON.stringify(envelope));
  }
  private finish(id: string) {
    try {
      this.storage?.removeItem(opKey(id));
    } catch {
      /* Reconciliation on reload is idempotent. */
    }
    this.publish({
      pending: this.state.pending.filter((p) => p.envelope.operationId !== id),
    });
  }
  private status(
    id: string,
    status: PendingOperation['status'],
    message?: string,
  ) {
    this.publish({
      pending: this.state.pending.map((p) =>
        p.envelope.operationId === id ? { ...p, status, message } : p,
      ),
    });
  }
  /** TI-038: explicit completion chosen by the owner; removes the envelope and its outbox row. */
  dismiss = (id: string) => this.finish(id);
  setConnected(connected: boolean) {
    this.publish({ connected, connectionFailed: !connected });
  }
  setRevoked() {
    this.publish({ revoked: true, connected: false, connectionFailed: true });
  }
  invalidateOperations() {
    this.publish({ operationsVersion: this.state.operationsVersion + 1 });
  }
  setToday(today: string) {
    if (today !== this.state.today) this.publish({ today });
  }
  loadSnapshot(snapshot: Snapshot) {
    // TI-003: within one generation the confirmed position never moves backwards.
    // A snapshot older than what live events already delivered is ignored and the
    // journal is caught up from the current position instead.
    if (
      snapshot.generation === this.state.generation &&
      snapshot.seq < this.state.seq
    ) {
      this.publish({ loading: false, error: '' });
      void this.catchUp();
      return;
    }
    this.epoch++;
    this.buffer.clear();
    this.publish({
      ...snapshot,
      confirmed: {
        tasks: snapshot.tasks,
        projects: snapshot.projects,
        comments: [],
      },
      loading: false,
      error: '',
      lastEvents: [],
    });
  }
  refresh = (): Promise<void> => this.startRefresh(false);
  /** The server reported another generation: a refresh already in flight belongs to the old one. */
  resync = (): Promise<void> => this.startRefresh(true);
  private startRefresh(generationChanged: boolean): Promise<void> {
    if (generationChanged) this.refreshEpoch++;
    else if (this.refreshFlight) return this.refreshFlight;
    const epoch = this.refreshEpoch;
    const flight = (async () => {
      this.publish({ loading: true, error: '' });
      try {
        const [snapshot, actor] = await Promise.all([
          this.transport<Snapshot>('/api/snapshot'),
          this.transport<Actor>('/api/me').catch(() => null),
        ]);
        if (epoch !== this.refreshEpoch) return;
        if (
          actor &&
          typeof actor.id === 'string' &&
          typeof actor.label === 'string'
        )
          this.publish({ actor });
        this.loadSnapshot(snapshot);
        await this.catchUp();
        await this.recover();
      } catch (error) {
        if (epoch !== this.refreshEpoch) return;
        this.publish({
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : 'Не удалось загрузить задачи.',
        });
        throw error;
      } finally {
        // One flight per epoch: a superseded flight leaves the slot to the newer one.
        if (epoch === this.refreshEpoch) this.refreshFlight = null;
      }
    })();
    this.refreshFlight = flight;
    return flight;
  }
  ingest = (events: DomainEvent[]) => {
    if (events.some((e) => e.generation !== this.state.generation)) {
      void this.resync().catch(() => {});
      return;
    }
    for (const event of events)
      if (event.seq > this.state.seq) this.buffer.set(event.seq, event);
    for (;;) {
      const first = this.buffer.get(this.state.seq + 1);
      if (!first || first.firstSeq !== this.state.seq + 1) break;
      const operation: DomainEvent[] = [];
      for (let seq = first.firstSeq; seq <= first.lastSeq; seq++) {
        const event = this.buffer.get(seq);
        if (
          !event ||
          event.operationId !== first.operationId ||
          event.firstSeq !== first.firstSeq ||
          event.lastSeq !== first.lastSeq
        )
          break;
        operation.push(event);
      }
      if (operation.length !== first.lastSeq - first.firstSeq + 1) break;
      let confirmed = this.state.confirmed;
      for (const event of operation) {
        confirmed = applyEvent(confirmed, event);
        this.buffer.delete(event.seq);
      }
      try {
        this.storage?.removeItem(opKey(first.operationId));
      } catch {
        /* Idempotent recovery handles stale outbox entries. */
      }
      this.publish({
        confirmed,
        seq: first.lastSeq,
        pending: this.state.pending.filter(
          (p) => p.envelope.operationId !== first.operationId,
        ),
        lastEvents: [...this.state.lastEvents, ...operation].slice(-500),
      });
    }
    if (this.buffer.size) void this.catchUp().catch(() => {});
  };
  async catchUp() {
    if (this.catchingUp || !this.state.generation) return;
    this.catchingUp = true;
    const epoch = this.epoch,
      generation = this.state.generation;
    try {
      let more = true;
      while (more && epoch === this.epoch) {
        let received = this.state.seq;
        while (this.buffer.has(received + 1)) received++;
        const page = await this.transport<EventsPage>(
          `/api/events?generation=${encodeURIComponent(generation)}&since=${received}&limit=500`,
        );
        if (epoch !== this.epoch) return;
        this.ingest(page.events);
        more = page.more;
        if (more && !page.events.length)
          throw new Error('Пустая страница журнала.');
      }
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.detail.code === 'generation_changed'
      )
        void this.resync().catch(() => {});
      else this.setConnected(false);
    } finally {
      this.catchingUp = false;
    }
  }
  acknowledge(result: OperationSuccess) {
    if (result.generation !== this.state.generation) {
      void this.resync().catch(() => {});
      return;
    }
    if (
      !result.events.length ||
      (result.lastSeq !== null && result.lastSeq <= this.state.seq)
    ) {
      this.finish(result.operationId);
      return;
    }
    this.status(result.operationId, 'acked');
    this.ingest(result.events);
  }
  submit(
    command: Command,
    operationId: string = crypto.randomUUID(),
  ): Promise<OperationSuccess> {
    if (!this.state.generation)
      return Promise.reject(new Error('Дождитесь загрузки пространства.'));
    if (!this.state.storageAvailable)
      return Promise.reject(new Error(STORAGE_UNAVAILABLE_MESSAGE));
    const envelope: OperationEnvelope = {
      ...command,
      operationId,
      generation: this.state.generation,
    };
    const existing = this.state.pending.find(
      (p) => p.envelope.operationId === operationId,
    );
    if (existing) {
      if (JSON.stringify(existing.envelope) !== JSON.stringify(envelope))
        return Promise.reject(
          new Error(
            'Предыдущее изменение ещё не подтверждено. Повторите его в панели состояния.',
          ),
        );
      return this.retry(operationId);
    }
    try {
      this.persist(envelope);
    } catch {
      return Promise.reject(
        new Error(
          'Не удалось сохранить запрос на устройстве. Освободите место и повторите.',
        ),
      );
    }
    this.publish({
      pending: [
        ...this.state.pending,
        {
          envelope,
          status: 'sending',
          previewTime: new Date().toISOString(),
          previewIds: [],
        },
      ],
    });
    return this.send(envelope);
  }
  retry(id: string) {
    const pending = this.state.pending.find(
      (p) => p.envelope.operationId === id,
    );
    if (!pending) return Promise.reject(new Error('Операция уже завершена.'));
    if (pending.envelope.generation !== this.state.generation)
      return Promise.reject(
        new Error(
          'Операция относится к прежней версии базы. Перенесите текст вручную.',
        ),
      );
    return this.send(pending.envelope);
  }
  private send(envelope: OperationEnvelope): Promise<OperationSuccess> {
    const id = envelope.operationId,
      flight = this.flights.get(id);
    if (flight) return flight;
    const promise = (async () => {
      for (let attempt = 0; ; attempt++) {
        this.status(id, 'sending');
        try {
          const result = await this.transport<OperationSuccess>(
            'commands' in envelope ? '/api/commands/batch' : '/api/commands',
            { method: 'POST', body: JSON.stringify(envelope) },
          );
          this.acknowledge(result);
          return result;
        } catch (error) {
          if (error instanceof ApiError && !error.detail.retryable) {
            this.finish(id);
            if (error.detail.code === 'generation_changed')
              void this.resync().catch(() => {});
            throw error;
          }
          this.status(id, 'unknown', 'Изменение не подтверждено');
          if (attempt >= 3) throw error;
          await this.delay(500 * 2 ** attempt);
          if (!this.state.pending.some((p) => p.envelope.operationId === id)) {
            const resolved = await this.transport<StoredOperation>(
              `/api/operations/${encodeURIComponent(id)}`,
            );
            if (resolved.result.ok) return resolved.result;
            throw new ApiError(resolved.result, resolved.status);
          }
          if (envelope.generation !== this.state.generation)
            throw new Error('Версия базы изменилась.');
        }
      }
    })().finally(() => this.flights.delete(id));
    this.flights.set(id, promise);
    return promise;
  }
  async recover() {
    const saved: OperationEnvelope[] = [];
    for (let i = 0; i < (this.storage?.length ?? 0); i++) {
      const key = this.storage?.key(i);
      if (!key?.startsWith('taskindex/ops/')) continue;
      try {
        const value = JSON.parse(this.storage!.getItem(key)!);
        if (value.operationId && value.generation) saved.push(value);
      } catch {
        /* An invalid outbox row is not executable. */
      }
    }
    for (const envelope of saved) {
      if (
        !this.state.pending.some(
          (p) => p.envelope.operationId === envelope.operationId,
        )
      )
        this.publish({
          pending: [
            ...this.state.pending,
            {
              envelope,
              status: 'unknown',
              previewTime: new Date().toISOString(),
              previewIds: [],
              // TI-038: an envelope of another generation is never resent; the owner
              // sees its text in the notice and removes it explicitly.
              ...(envelope.generation !== this.state.generation
                ? { message: 'Изменение от прежней версии базы' }
                : {}),
            },
          ],
        });
      if (envelope.generation !== this.state.generation) continue;
      try {
        const operation = await this.transport<StoredOperation>(
          `/api/operations/${encodeURIComponent(envelope.operationId)}`,
        );
        if (operation.result.ok) this.acknowledge(operation.result);
        else if (!operation.result.retryable) this.finish(envelope.operationId);
      } catch (error) {
        if (error instanceof ApiError && error.detail.code === 'not_found')
          void this.send(envelope).catch(() => {});
      }
    }
  }
}
export const workspaceStore = new WorkspaceStore();
