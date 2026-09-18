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
export function parseLocation(address: string): LocationState {
  // Bare queries also support preferences saved before path-based navigation.
  const path = address.startsWith('/') ? address.split('?')[0]! : '/';
  const search = address.startsWith('/')
    ? address.slice(path.length + 1)
    : address;
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
    ...parsePath(path),
  };
}
function parsePath(path: string): Partial<LocationState> {
  const route = path.replace(/\/$/, '');
  if (route === '/focus' || route === '/activity')
    return {
      focus: route === '/focus',
      activity: route === '/activity',
      archive: false,
    };
  const match =
    /^\/([^/]+)(?:\/projects\/([^/]+)|\/(unassigned))?(\/archive)?$/.exec(
      route,
    );
  if (!match || !AREAS.some((area) => area.id === match[1])) return {};
  try {
    let project = match[3] ? 'none' : 'all';
    if (match[2]) project = decodeURIComponent(match[2]);
    return {
      area: match[1] as AreaId,
      project,
      archive: Boolean(match[4]),
      focus: false,
      activity: false,
    };
  } catch {
    // Invalid percent encoding in a manually entered link must not crash the app.
    return {};
  }
}
/** @internal for tests */
export function serializeLocation(state: LocationState): string {
  const globalScreen = state.activity || state.focus;
  let path = `/${state.area}`;
  if (state.activity) path = '/activity';
  else if (state.focus) path = '/focus';
  if (!globalScreen) {
    if (state.project === 'none') path += '/unassigned';
    else if (state.project !== 'all')
      path += `/projects/${encodeURIComponent(state.project)}`;
    if (state.archive) path += '/archive';
  }
  const inPath = new Set([
    'focus',
    'activity',
    'archive',
    ...(!globalScreen ? ['area', 'project'] : []),
  ]);
  const p = new URLSearchParams();
  for (const [key, val] of Object.entries(state))
    if (!inPath.has(key) && val !== defaultLocation[key as keyof LocationState])
      p.set(key, val === true ? '1' : String(val));
  const query = p.toString();
  return `${path}${query ? `?${query}` : ''}`;
}

function savedLocation(): string {
  try {
    return localStorage.getItem(savedKey) || '';
  } catch {
    return '';
  }
}
function rememberLocation(state: LocationState) {
  try {
    // Open tasks, search text and the context drawer are temporary UI state.
    localStorage.setItem(
      savedKey,
      serializeLocation({ ...state, task: '', q: '', contexts: false }),
    );
  } catch {
    /* Optional preference. */
  }
}
function currentAddress() {
  return location.pathname + location.search;
}
function canonicalize(state: LocationState) {
  const address = serializeLocation(state);
  if (currentAddress() !== address) history.replaceState(null, '', address);
}
export function useLocationState() {
  const [value, setValue] = useState(() => {
    const address = currentAddress();
    const initial = parseLocation(address === '/' ? savedLocation() : address);
    // The first history entry carries the state it displays, so "back" to it
    // restores that view instead of whatever was remembered later.
    canonicalize(initial);
    return initial;
  });
  useEffect(() => {
    const listener = () => {
      const next = parseLocation(currentAddress());
      canonicalize(next);
      setValue(next);
    };
    window.addEventListener('popstate', listener);
    return () => window.removeEventListener('popstate', listener);
  }, []);
  const update = useCallback(
    (patch: Partial<LocationState>, replace = false) =>
      setValue((old) => {
        const next = { ...old, ...patch },
          address = serializeLocation(next);
        if (currentAddress() !== address)
          history[replace ? 'replaceState' : 'pushState'](null, '', address);
        rememberLocation(next);
        return next;
      }),
    [],
  );
  return [value, update] as const;
}
