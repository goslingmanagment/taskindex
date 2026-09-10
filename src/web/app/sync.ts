import { todayInTimezone } from '@shared/queries';
import { workspaceStore, type WorkspaceStore } from './store';
export function startSync(store: WorkspaceStore = workspaceStore) {
  let stream: EventSource | null = null,
    closed = false,
    identity = '';
  const connect = () => {
    const state = store.getSnapshot();
    if (closed || state.loading || !state.generation) return;
    const next = state.generation;
    if (next === identity && stream) return;
    stream?.close();
    identity = next;
    stream = new EventSource(
      `/api/events/stream?generation=${encodeURIComponent(next)}&since=${state.seq}`,
    );
    stream.onopen = () => {
      store.setConnected(true);
      // Reconcile operations that were recorded while this connection was down.
      store.invalidateOperations();
    };
    stream.onerror = () => store.setConnected(false);
    stream.onmessage = (event) => {
      try {
        store.ingest([JSON.parse(event.data)]);
      } catch {
        void store.catchUp();
      }
    };
    stream.addEventListener('reset', () => {
      stream?.close();
      stream = null;
      identity = '';
      void store.resync().catch(() => {});
    });
    stream.addEventListener('operations', () => store.invalidateOperations());
  };
  const unsubscribe = store.subscribe(connect);
  void store
    .refresh()
    .then(connect)
    .catch(() => {});
  const timer = setInterval(() => {
    const state = store.getSnapshot();
    store.setToday(todayInTimezone(state.timezone));
    if (!state.connected) void store.catchUp();
  }, 60000);
  const online = () => {
    void store.catchUp();
    void store.recover();
  };
  window.addEventListener('online', online);
  return () => {
    closed = true;
    unsubscribe();
    stream?.close();
    clearInterval(timer);
    window.removeEventListener('online', online);
  };
}
