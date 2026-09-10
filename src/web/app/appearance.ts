import { APPEARANCE_MODES, type AppearanceMode } from '@shared/appearance';
import { workspaceStore } from './store';
// TI-025: the owner's theme. The workspace record is the truth (it syncs
// between devices through `appearance.update`); the local cache exists only so
// the first paint of the next visit is already the right colour — the early
// script in index.html reads it before the bundle loads.
const CACHE_KEY = 'taskindex/appearance-mode';
export const APPEARANCE_LABELS: Record<AppearanceMode, string> = {
  system: 'Как в системе',
  light: 'Светлая',
  dark: 'Тёмная',
};
export function cachedMode(): AppearanceMode {
  try {
    const value = localStorage.getItem(CACHE_KEY);
    return APPEARANCE_MODES.includes(value as AppearanceMode)
      ? (value as AppearanceMode)
      : 'system';
  } catch {
    return 'system';
  }
}
// `system` means «no choice»: the attribute is removed so the media query in
// tokens.css decides, and `prefers-color-scheme` keeps working live.
export function applyMode(mode: AppearanceMode) {
  const root = document.documentElement;
  if (mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = mode;
  try {
    if (mode === 'system') localStorage.removeItem(CACHE_KEY);
    else localStorage.setItem(CACHE_KEY, mode);
  } catch {
    /* A private window keeps the choice for this tab only. */
  }
}
export async function chooseMode(mode: AppearanceMode) {
  const appearance = workspaceStore.getSnapshot().data.appearance[0];
  applyMode(mode);
  await workspaceStore.submit({
    command: 'appearance.update',
    payload: { baseRevision: appearance?.revision ?? 0, mode },
  });
}
