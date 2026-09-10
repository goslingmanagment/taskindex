import { useSyncExternalStore } from 'react';
// TI-025: the phone breakpoint lives in the theme (`--breakpoint-md` in
// tokens.css), so the media queries of the skin and this hook cannot drift
// apart. The literal below is only the fallback for a build where the variable
// was not emitted into `:root`.
export const FALLBACK_BREAKPOINT = '48rem';
export function mobileQuery(breakpoint: string): string {
  return `(width < ${breakpoint.trim() || FALLBACK_BREAKPOINT})`;
}
export function currentQuery(): string {
  try {
    return mobileQuery(
      getComputedStyle(document.documentElement).getPropertyValue(
        '--breakpoint-md',
      ),
    );
  } catch {
    return mobileQuery(FALLBACK_BREAKPOINT);
  }
}
export function isMobile(): boolean {
  return window.matchMedia(currentQuery()).matches;
}
function subscribe(callback: () => void) {
  const media = window.matchMedia(currentQuery());
  media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
}
export function useIsMobile() {
  return useSyncExternalStore(subscribe, isMobile, () => false);
}
