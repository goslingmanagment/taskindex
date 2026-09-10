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
const defaults: LocationState = {
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
function read(): LocationState {
  let search = location.search;
  if (!search)
    try {
      search = localStorage.getItem('taskindex/location') || '';
    } catch {
      /* Optional preference. */
    }
  const p = new URLSearchParams(search),
    area = p.get('area');
  return {
    ...defaults,
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
export function useLocationState() {
  const [value, setValue] = useState(read);
  useEffect(() => {
    const listener = () => setValue(read());
    window.addEventListener('popstate', listener);
    return () => window.removeEventListener('popstate', listener);
  }, []);
  const update = useCallback(
    (patch: Partial<LocationState>, replace = false) =>
      setValue((old) => {
        const next = { ...old, ...patch },
          p = new URLSearchParams();
        for (const [key, val] of Object.entries(next))
          if (val !== false && val !== '')
            p.set(key, val === true ? '1' : String(val));
        const query = `?${p.toString()}`;
        if (location.search !== query)
          history[replace ? 'replaceState' : 'pushState'](null, '', query);
        try {
          const saved = new URLSearchParams(query);
          saved.delete('task');
          saved.delete('q');
          localStorage.setItem('taskindex/location', saved.toString());
        } catch {
          /* Optional preference. */
        }
        return next;
      }),
    [],
  );
  return [value, update] as const;
}
