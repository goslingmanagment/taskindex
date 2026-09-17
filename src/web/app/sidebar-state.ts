// The navigation panel remembers whether the owner hid it on this device. A
// laptop wants the board wide, a monitor has room for the panel: the choice is
// per browser, so it lives in localStorage, not in the synced appearance
// record. Absence means «open»: a fresh browser shows the panel.
export const SIDEBAR_STORAGE_KEY = 'taskindex/sidebar';
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
/** `localStorage`, or nothing when the browser refuses it (private window). */
export function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
export function readSidebarOpen(storage: StorageLike | undefined): boolean {
  try {
    return storage?.getItem(SIDEBAR_STORAGE_KEY) !== 'collapsed';
  } catch {
    return true;
  }
}
export function writeSidebarOpen(
  storage: StorageLike | undefined,
  open: boolean,
): void {
  try {
    if (open) storage?.removeItem(SIDEBAR_STORAGE_KEY);
    else storage?.setItem(SIDEBAR_STORAGE_KEY, 'collapsed');
  } catch {
    /* A private window keeps the choice for this tab only. */
  }
}
/** «⌘B» on Apple platforms, «Ctrl+B» elsewhere: the hint in button titles. */
export function shortcutHint(key: string, platform: string): string {
  return /Mac|iPhone|iPad|iPod/.test(platform) ? `⌘${key}` : `Ctrl+${key}`;
}
