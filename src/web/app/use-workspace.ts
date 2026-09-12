import { useSyncExternalStore } from 'react';
import { workspaceStore } from './store';
import { createFrameSubscription } from './frame-subscription';
// TI-059 (план 07, шаг 9): подписка и только она. Всё, что раньше висело на
// этом хуке (билдеры команд, отправка, счётчики), уехало в `commands.ts`,
// `use-workspace-commands.ts` и `selectors.ts`.
export function useWorkspace() {
  return useSyncExternalStore(
    workspaceStore.subscribe,
    workspaceStore.getSnapshot,
    workspaceStore.getSnapshot,
  );
}

const subscribeFrame = createFrameSubscription(workspaceStore, {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
});

// Only board rendering combines notifications. In a hidden tab RAF can pause,
// while the store and its synchronous effect consumers must keep processing
// every event/connection edge. Both hooks always read the same live snapshot.
export function useWorkspaceFrame() {
  return useSyncExternalStore(
    subscribeFrame,
    workspaceStore.getSnapshot,
    workspaceStore.getSnapshot,
  );
}
