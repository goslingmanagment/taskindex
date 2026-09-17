import type {
  Actor,
  Command,
  DomainEvent,
  OperationEnvelope,
  OperationSuccess,
  Snapshot,
  WorkspaceState,
} from '@shared/model';
import { ignoreRejection } from '@shared/ignore-rejection';
import { applyEvent, applyCommand } from '@shared/commands';
import {
  actorSchema,
  defaultAppearance,
  eventsPageSchema,
  operationSuccessSchema,
  snapshotSchema,
  storedOperationSchema,
} from '@shared/domain-schemas';
import { z } from 'zod';
import { batchEnvelopeSchema, commandEnvelopeSchema } from '@shared/schemas';
const envelopeSchema = z.union([commandEnvelopeSchema, batchEnvelopeSchema]);
import { ApiError, ContractMismatch, request } from './api';
import { browserStorage, quarantine, type StorageLike } from './drafts';
type PendingOperation = {
  envelope: OperationEnvelope;
  status: 'sending' | 'unknown' | 'acked';
  previewTime: string;
  previewIds: string[];
  message?: string;
};
type StoreState = {
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
  /**
   * TI-025 (план 04, доп. 15): снимок пришёл с другой версией схемы сервера.
   * Клиент этой сборки больше не понимает контракт: отправка команд
   * останавливается, черновики и pending не трогаются, владелец перезагружает
   * страницу и получает свежий бандл.
   */
  incompatible: boolean;
  /** TI-074: who this client acts as (`GET /api/me`); previews are attributed to it. */
  actor: Actor | null;
};
const FALLBACK_ACTOR: Actor = {
  id: 'owner',
  label: 'Владелец',
  kind: 'owner',
  scope: 'write',
};
export const SERVER_UPDATED_MESSAGE =
  'Сервер обновлён. Перезагрузите страницу, чтобы продолжить.';
export const STORAGE_UNAVAILABLE_MESSAGE =
  'Хранилище браузера недоступно: изменения не отправляются. Скопируйте текст и повторите в обычном окне.';
// TI-005: транспорт получает схему ответа вместе с путём, поэтому в состояние
// не может попасть тело, которое не проходит контракт (план 07, шаг 8).
export type Transport = <T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
) => Promise<T>;
const empty = (): WorkspaceState => ({
  projects: [],
  labels: [],
  tasks: [],
  comments: [],
  appearance: [defaultAppearance()],
});
const opKey = (id: string) => `taskindex/ops/${id}`;
/** План 04, доп. 14: ответ не относится к отправленному конверту. */
class MismatchedResponse extends Error {
  constructor() {
    super('Ответ относится к другой операции.');
  }
}
export class WorkspaceStore {
  private state: StoreState = {
    confirmed: empty(),
    data: empty(),
    generation: '',
    seq: 0,
    today: '',
    // TI-074 (план 07, шаг 17): часовой пояс приходит со снимком. До него его
    // не знает никто, и подставлять московский — значит один раз показать
    // владельцу чужое «сегодня».
    timezone: '',
    pending: [],
    loading: true,
    error: '',
    connected: false,
    connectionFailed: false,
    lastEvents: [],
    operationsVersion: 0,
    storageAvailable: true,
    revoked: false,
    incompatible: false,
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
          const applied = applyCommand(
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
          );
          // Command validation works on a private clone. Publish only its
          // effects so unchanged records keep their identity (TI-085).
          // The same reducer also handles commentCount on the parent task.
          preview = applied.effects.reduce(
            (current, effect) =>
              applyEvent(current, { ...effect, at: pending.previewTime }),
            preview,
          );
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
  private schemaVersion: number | null = null;
  loadSnapshot(snapshot: Snapshot) {
    // План 04, доп. 15: версия схемы первого снимка запоминается. Другое
    // значение означает, что сервер обновился под работающей вкладкой: команды
    // этой сборки больше не гарантированы, поэтому отправка останавливается.
    if (snapshot.schemaVersion !== undefined) {
      if (this.schemaVersion === null)
        this.schemaVersion = snapshot.schemaVersion;
      else if (this.schemaVersion !== snapshot.schemaVersion)
        this.publish({ incompatible: true });
    }
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
        labels: snapshot.labels,
        comments: [],
        appearance: [snapshot.appearance ?? defaultAppearance()],
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
          this.transport('/api/snapshot', snapshotSchema),
          this.transport('/api/me', actorSchema).catch(() => null),
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
        // Причина уходит наверх целиком: баннер показывает текст, а вызвавший
        // код (и консоль) получает исходную ошибку транспорта.
        throw new Error('Не удалось загрузить пространство.', {
          cause: error,
        });
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
      ignoreRejection(
        this.resync(),
        'смена поколения: состояние восстановит следующий снимок',
      );
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
    if (this.buffer.size)
      ignoreRejection(
        this.catchUp(),
        'догон журнала: неудача помечает соединение офлайн',
      );
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
        const page = await this.transport(
          `/api/events?generation=${encodeURIComponent(generation)}&since=${received}&limit=500`,
          eventsPageSchema,
        );
        if (epoch !== this.epoch) return;
        this.ingest(page.events);
        more = page.more;
        if (more && !page.events.length)
          throw new Error(
            `Пустая страница журнала: сервер обещал продолжение после ${received}.`,
          );
      }
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.detail.code === 'generation_changed'
      )
        ignoreRejection(
          this.resync(),
          'смена поколения при догоне: перезагрузка снимка',
        );
      else this.setConnected(false);
    } finally {
      this.catchingUp = false;
    }
  }
  acknowledge(result: OperationSuccess) {
    if (result.generation !== this.state.generation) {
      ignoreRejection(
        this.resync(),
        'подтверждение из другого поколения: перезагрузка снимка',
      );
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
    if (this.state.incompatible)
      return Promise.reject(new Error(SERVER_UPDATED_MESSAGE));
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
        // Every POST, including recovery and a retry after backoff, uses this
        // guard. A contract change never discards the persisted intent.
        if (this.state.incompatible) {
          this.status(id, 'unknown', SERVER_UPDATED_MESSAGE);
          throw new Error(SERVER_UPDATED_MESSAGE);
        }
        this.status(id, 'sending');
        try {
          const result = await this.transport(
            'commands' in envelope ? '/api/commands/batch' : '/api/commands',
            operationSuccessSchema,
            { method: 'POST', body: JSON.stringify(envelope) },
          );
          // Доп. 14 плана 04: ответ обязан относиться к этому конверту и к
          // этому поколению. Чужой ответ не подтверждает ничего: конверт
          // остаётся в pending, и владелец видит «не подтверждено».
          if (
            result.operationId !== id ||
            result.generation !== this.state.generation
          ) {
            this.status(id, 'unknown', 'Ответ относится к другой операции');
            throw new MismatchedResponse();
          }
          this.acknowledge(result);
          return result;
        } catch (error) {
          if (error instanceof ContractMismatch) {
            this.status(id, 'unknown', SERVER_UPDATED_MESSAGE);
            this.publish({ incompatible: true });
            throw error;
          }
          // Конверт уже помечен «не подтверждено» и остаётся в pending: его
          // судьбу решит recover, а не повтор с тем же телом.
          if (error instanceof MismatchedResponse) throw error;
          if (error instanceof ApiError && !error.detail.retryable) {
            this.finish(id);
            if (error.detail.code === 'generation_changed')
              ignoreRejection(
                this.resync(),
                'отказ по смене поколения: перезагрузка снимка',
              );
            throw error;
          }
          this.status(id, 'unknown', 'Изменение не подтверждено');
          if (attempt >= 3) throw error;
          await this.delay(500 * 2 ** attempt);
          if (!this.state.pending.some((p) => p.envelope.operationId === id)) {
            const resolved = await this.transport(
              `/api/operations/${encodeURIComponent(id)}`,
              storedOperationSchema,
            );
            if (resolved.result.ok) return resolved.result;
            throw new ApiError(resolved.result, resolved.status);
          }
          if (envelope.generation !== this.state.generation)
            // Причина сохраняется в cause: по тексту «Версия базы изменилась»
            // не видно, чем именно закончилась попытка отправки.
            throw new Error('Версия базы изменилась.', { cause: error });
        }
      }
    })().finally(() => this.flights.delete(id));
    this.flights.set(id, promise);
    return promise;
  }
  async recover() {
    const saved: OperationEnvelope[] = [];
    // Ключи снимаются заранее: карантин удаляет и добавляет записи, поэтому
    // обход по индексам пропустил бы следующую строку.
    const keys: string[] = [];
    for (let i = 0; i < (this.storage?.length ?? 0); i++) {
      const key = this.storage?.key(i);
      if (key) keys.push(key);
    }
    for (const key of keys) {
      if (!key.startsWith('taskindex/ops/')) continue;
      try {
        const value: unknown = JSON.parse(this.storage!.getItem(key) ?? '');
        // План 04, доп. 16: конверт проверяется схемой, а не двумя полями.
        // Непонятная строка уезжает в карантин, а не роняет восстановление.
        const parsed = envelopeSchema.safeParse(value);
        if (parsed.success) saved.push(parsed.data);
        else quarantine(this.storage, key, 'не соответствует схеме конверта');
      } catch {
        quarantine(this.storage, key, 'не разбирается как JSON');
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
        const operation = await this.transport(
          `/api/operations/${encodeURIComponent(envelope.operationId)}`,
          storedOperationSchema,
        );
        if (operation.result.ok) this.acknowledge(operation.result);
        else if (!operation.result.retryable) this.finish(envelope.operationId);
      } catch (error) {
        if (error instanceof ContractMismatch) {
          this.status(envelope.operationId, 'unknown', SERVER_UPDATED_MESSAGE);
          this.publish({ incompatible: true });
        } else if (
          error instanceof ApiError &&
          error.detail.code === 'not_found'
        )
          ignoreRejection(
            this.send(envelope),
            'повтор конверта при восстановлении: результат виден в pending',
          );
      }
    }
  }
}
export const workspaceStore = new WorkspaceStore();
