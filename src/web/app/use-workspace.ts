import { useSyncExternalStore } from 'react';
import { workspaceStore } from './store';
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
