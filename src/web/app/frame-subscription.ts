import type { WorkspaceStore } from './store';

type Subscribe = (listener: () => void) => () => void;
type WorkspaceSource = Pick<WorkspaceStore, 'subscribe' | 'getSnapshot'>;
type Snapshot = ReturnType<WorkspaceSource['getSnapshot']>;
type FrameScheduler = {
  request(callback: () => void): number;
  cancel(id: number): void;
};

function controlsChanged(before: Snapshot, after: Snapshot) {
  return (
    before.generation !== after.generation ||
    before.loading !== after.loading ||
    before.incompatible !== after.incompatible ||
    before.revoked !== after.revoked ||
    before.storageAvailable !== after.storageAvailable ||
    before.connected !== after.connected ||
    before.connectionFailed !== after.connectionFailed ||
    before.error !== after.error ||
    before.actor?.id !== after.actor?.id ||
    before.actor?.kind !== after.actor?.kind ||
    before.actor?.scope !== after.actor?.scope ||
    before.pending.length !== after.pending.length ||
    before.pending.some((operation, i) => operation !== after.pending[i])
  );
}

export function createFrameSubscription(
  store: WorkspaceSource,
  scheduler: FrameScheduler,
): Subscribe {
  const listeners = new Set<() => void>();
  let frame: number | undefined;
  let unsubscribe: (() => void) | undefined;
  const flush = () => {
    // A listener may publish again: that update belongs to the next frame.
    frame = undefined;
    for (const listener of listeners) listener();
  };
  return (listener) => {
    listeners.add(listener);
    if (!unsubscribe) {
      let previous = store.getSnapshot();
      unsubscribe = store.subscribe(() => {
        const current = store.getSnapshot();
        const immediate = controlsChanged(previous, current);
        previous = current;
        // Generation and write controls must update forms immediately. A new
        // pending array with the same elements (foreign events) is not a change.
        if (immediate) {
          if (frame !== undefined) scheduler.cancel(frame);
          flush();
        } else if (frame === undefined) frame = scheduler.request(flush);
      });
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size) return;
      unsubscribe?.();
      unsubscribe = undefined;
      if (frame !== undefined) scheduler.cancel(frame);
      frame = undefined;
    };
  };
}
