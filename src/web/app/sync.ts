import { todayInTimezone } from '@shared/queries';
import { ignoreRejection } from '@shared/ignore-rejection';
import { actorSchema } from '@shared/domain-schemas';
import { ApiError, request } from './api';
import type { Transport } from './store';
import { workspaceStore, type WorkspaceStore } from './store';
const SSE_RECONNECT_MIN_MS = 1000;
/** @internal for tests */
export const SSE_RECONNECT_MAX_MS = 30000;
/** @internal for tests */
export const RESYNC_INTERVAL_MS = 60000;
/** @internal for tests */
export type SyncDeps = {
  EventSource: typeof EventSource;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  addEventListener: (type: 'online', fn: () => void) => void;
  removeEventListener: (type: 'online', fn: () => void) => void;
  request: Transport;
};
const browserSyncDeps = (): SyncDeps => ({
  EventSource,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as number),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as number),
  addEventListener: (type, fn) => window.addEventListener(type, fn),
  removeEventListener: (type, fn) => window.removeEventListener(type, fn),
  request,
});
// TI-043: the browser retries an EventSource only while it is CONNECTING. Once it
// is CLOSED (401/5xx, wrong content type, proxy failure) the stream is recreated
// here with exponential backoff, after /api/me confirms the session still holds;
// 401/403 there, and the server's `revoked` event, end reconnection for good.
export function startSync(
  store: WorkspaceStore = workspaceStore,
  deps: SyncDeps = browserSyncDeps(),
) {
  let stream: EventSource | null = null,
    identity = '',
    closed = false,
    revoked = false,
    attempt = 0,
    reconnect: unknown = null;
  const connect = () => {
    const state = store.getSnapshot();
    if (closed || revoked || state.loading || !state.generation) return;
    const next = state.generation;
    if (next === identity) {
      if (stream && stream.readyState !== deps.EventSource.CLOSED) return;
      if (reconnect !== null) return;
    } else if (reconnect !== null) {
      deps.clearTimeout(reconnect);
      reconnect = null;
    }
    stream?.close();
    identity = next;
    const source = new deps.EventSource(
      `/api/events/stream?generation=${encodeURIComponent(next)}&since=${state.seq}`,
    );
    stream = source;
    source.onopen = () => {
      if (source !== stream) return;
      attempt = 0;
      store.setConnected(true);
      // Reconcile operations that were recorded while this connection was down.
      store.invalidateOperations();
    };
    source.onerror = () => {
      if (source !== stream) return;
      if (source.readyState === deps.EventSource.CLOSED) {
        stream = null;
        schedule();
      }
      store.setConnected(false);
    };
    source.onmessage = (event) => {
      try {
        store.ingest([JSON.parse(event.data)]);
      } catch {
        void store.catchUp();
      }
    };
    source.addEventListener('reset', () => {
      if (source !== stream) return;
      source.close();
      stream = null;
      identity = '';
      ignoreRejection(
        store.resync(),
        'сброс потока: следующий снимок вернёт состояние',
      );
    });
    source.addEventListener('operations', () => store.invalidateOperations());
    source.addEventListener('revoked', () => {
      if (source !== stream) return;
      source.close();
      stream = null;
      stop();
    });
  };
  const stop = () => {
    revoked = true;
    if (reconnect !== null) deps.clearTimeout(reconnect);
    reconnect = null;
    store.setRevoked();
  };
  const schedule = () => {
    if (closed || revoked || reconnect !== null) return;
    const delay = Math.min(
      SSE_RECONNECT_MIN_MS * 2 ** attempt,
      SSE_RECONNECT_MAX_MS,
    );
    attempt++;
    reconnect = deps.setTimeout(() => {
      reconnect = null;
      void deps
        .request('/api/me', actorSchema)
        .then(connect)
        .catch((error: unknown) => {
          if (
            error instanceof ApiError &&
            (error.status === 401 || error.status === 403)
          )
            stop();
          else schedule();
        });
    }, delay);
  };
  const unsubscribe = store.subscribe(connect);
  ignoreRejection(
    store.refresh().then(connect),
    'первая загрузка: ошибка уже показана баннером состояния',
  );
  const timer = deps.setInterval(() => {
    const state = store.getSnapshot();
    // Пояс пустой, пока не пришёл снимок: «сегодня» тогда считать не из чего.
    if (state.timezone) store.setToday(todayInTimezone(state.timezone));
    if (state.connected || revoked) return;
    void store.catchUp();
    if (stream === null && reconnect === null) connect();
  }, RESYNC_INTERVAL_MS);
  const online = () => {
    if (revoked) return;
    void store.catchUp();
    void store.recover();
    if (stream === null && reconnect === null) connect();
  };
  deps.addEventListener('online', online);
  return () => {
    closed = true;
    unsubscribe();
    stream?.close();
    if (reconnect !== null) deps.clearTimeout(reconnect);
    deps.clearInterval(timer);
    deps.removeEventListener('online', online);
  };
}
