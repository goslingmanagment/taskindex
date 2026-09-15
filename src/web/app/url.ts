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
  /** Колонка «Готово» на доске области; по умолчанию скрыта. */
  done: boolean;
  archiveSearch: boolean;
  activity: boolean;
  /** TI-076: author filter of the activity feed; '' is everyone. */
  actor: string;
  /** TI-078: ящик «Все контексты» открыт поверх стола. */
  contexts: boolean;
  /** Фильтр ящика по состоянию задачи; '' — любое. */
  status: string;
  /** Фильтр ящика «не на столе» (`focus: false`), счётчик `counts.parked`. */
  parked: boolean;
};
/** @internal for tests */
export const defaultLocation: LocationState = {
  area: 'agency',
  project: 'all',
  view: 'board',
  task: '',
  q: '',
  focus: false,
  archive: false,
  today: false,
  done: false,
  archiveSearch: false,
  activity: false,
  actor: '',
  contexts: false,
  status: '',
  parked: false,
};
const savedKey = 'taskindex/location';
// TI-042: two ways to read the location. The URL is the only source for
// history navigation; the remembered location is used once, when the app
// opens on a bare `/`.
/** @internal for tests */
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
    actor: p.get('actor') || '',
    status: p.get('status') || '',
    ...Object.fromEntries(
      [
        'focus',
        'archive',
        'today',
        'done',
        'archiveSearch',
        'activity',
        'contexts',
        'parked',
      ].map((k) => [k, p.get(k) === '1']),
    ),
  };
}
/** @internal for tests */
export function serializeLocation(state: LocationState): string {
  const p = new URLSearchParams();
  for (const [key, val] of Object.entries(state))
    if (val !== false && val !== '')
      p.set(key, val === true ? '1' : String(val));
  return `?${p.toString()}`;
}
function savedLocation(): string {
  try {
    return localStorage.getItem(savedKey) || '';
  } catch {
    return '';
  }
}
function rememberLocation(query: string) {
  try {
    const saved = new URLSearchParams(query);
    saved.delete('task');
    saved.delete('q');
    // TI-078: ящик контекстов — временное окно поверх стола, как карточка.
    saved.delete('contexts');
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
