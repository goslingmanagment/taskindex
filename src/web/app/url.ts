import { useCallback, useEffect, useState } from 'react';
import { AREAS, type AreaId } from '@shared/model';
export type LocationState = {
  area: AreaId;
  project: string;
  view: 'board' | 'list';
  task: string;
  q: string;
  focus: boolean;
  archive: boolean;
  today: boolean;
  archiveSearch: boolean;
  activity: boolean;
};
export const defaultLocation: LocationState = {
  area: 'agency',
  project: 'all',
  view: 'board',
  task: '',
  q: '',
  focus: false,
  archive: false,
  today: false,
  archiveSearch: false,
  activity: false,
};
const savedKey = 'taskindex/location';
// TI-042: two ways to read the location. The URL is the only source for
// history navigation; the remembered location is used once, when the app
// opens on a bare `/`.
export function parseLocation(search: string): LocationState {
  const p = new URLSearchParams(search),
    area = p.get('area');
  return {
    ...defaultLocation,
    area: AREAS.some((a) => a.id === area) ? (area as AreaId) : 'agency',
    project: p.get('project') || 'all',
    view: p.get('view') === 'list' ? 'list' : 'board',
    task: p.get('task') || '',
    q: p.get('q') || '',
    ...Object.fromEntries(
      ['focus', 'archive', 'today', 'archiveSearch', 'activity'].map((k) => [
        k,
        p.get(k) === '1',
      ]),
    ),
  };
}
export function serializeLocation(state: LocationState): string {
  const p = new URLSearchParams();
  for (const [key, val] of Object.entries(state))
    if (val !== false && val !== '')
      p.set(key, val === true ? '1' : String(val));
  return `?${p.toString()}`;
}
export function savedLocation(): string {
  try {
    return localStorage.getItem(savedKey) || '';
  } catch {
    return '';
  }
}
export function rememberLocation(query: string) {
  try {
    const saved = new URLSearchParams(query);
    saved.delete('task');
    saved.delete('q');
    localStorage.setItem(savedKey, saved.toString());
  } catch {
    /* Optional preference. */
  }
}
export function useLocationState() {
  const [value, setValue] = useState(() => {
    const initial = parseLocation(location.search || savedLocation());
    // The first history entry carries the state it displays, so "back" to it
    // restores that view instead of whatever was remembered later.
    if (!location.search)
      history.replaceState(null, '', serializeLocation(initial));
    return initial;
  });
  useEffect(() => {
    const listener = () => setValue(parseLocation(location.search));
    window.addEventListener('popstate', listener);
    return () => window.removeEventListener('popstate', listener);
  }, []);
  const update = useCallback(
    (patch: Partial<LocationState>, replace = false) =>
      setValue((old) => {
        const next = { ...old, ...patch },
          query = serializeLocation(next);
        if (location.search !== query)
          history[replace ? 'replaceState' : 'pushState'](null, '', query);
        rememberLocation(query);
        return next;
      }),
    [],
  );
  return [value, update] as const;
}
