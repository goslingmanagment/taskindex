import {
  DEFAULT_SKIN_ID,
  type AppearanceMode,
  type SKINS,
} from '@shared/appearance';
import { workspaceStore } from './store';
// TI-025: the owner's theme. The workspace record is the truth (it syncs
// between devices through `appearance.update`); the local cache exists only so
// the first paint of the next visit is already the right colour — the early
// script in index.html reads it before the bundle loads.
const CACHE_KEY = 'taskindex/appearance-mode';
const SKIN_CACHE_KEY = 'taskindex/appearance-skin';
export const APPEARANCE_LABELS: Record<AppearanceMode, string> = {
  system: 'Как в системе',
  light: 'Светлая',
  dark: 'Тёмная',
};
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
// TI-026: the skin. Classic is the palette without a selector, so it clears
// the attribute; any other id selects its `:root[data-skin]` blocks in
// tokens.css. An id this build does not know paints Classic (astra-26).
export function applySkin(skinId: string) {
  const root = document.documentElement;
  if (skinId === DEFAULT_SKIN_ID) delete root.dataset.skin;
  else root.dataset.skin = skinId;
  try {
    if (skinId === DEFAULT_SKIN_ID) localStorage.removeItem(SKIN_CACHE_KEY);
    else localStorage.setItem(SKIN_CACHE_KEY, skinId);
  } catch {
    /* A private window keeps the choice for this tab only. */
  }
}
export async function chooseSkin(skinId: (typeof SKINS)[number]['id']) {
  const appearance = workspaceStore.getSnapshot().data.appearance[0];
  applySkin(skinId);
  await workspaceStore.submit({
    command: 'appearance.update',
    payload: { baseRevision: appearance?.revision ?? 0, skinId },
  });
}
