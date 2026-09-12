import type {
  Project,
  Task,
  FocusGroup,
  FocusDesk,
  AreaId,
  Status,
} from './model.js';
import { LIMITS } from './limits.js';
import { isAgentActor, projectFilterToId } from './constants.js';
export const compareStrings = (a: string, b: string) => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};
export const byOrder = (a: Task, b: Task) =>
  compareStrings(a.orderKey, b.orderKey) || compareStrings(a.id, b.id);
// The desk order: only tasks in focus carry a key, so '' never competes.
export const byFocusKey = (a: Task, b: Task) =>
  compareStrings(a.focusKey ?? '', b.focusKey ?? '') ||
  compareStrings(a.id, b.id);
export function todayInTimezone(
  timezone: string,
  now: Date | string = new Date(),
): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const pick = (type: string) => parts.find((x) => x.type === type)?.value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}
// Labels share one immutable formatter; constructing Intl for every visible
// card made navigation and drag renders expensive on large boards (TI-085).
const taskDateFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
export function dateLabel(value: string | null, today: string): string {
  if (!value) return '';
  if (value === today) return 'Сегодня';
  const next = new Date(`${today}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  if (value === next.toISOString().slice(0, 10)) return 'Завтра';
  return taskDateFormat.format(new Date(`${value}T12:00:00Z`)).replace('.', '');
}
export function searchTasks(
  tasks: Task[],
  projects: Project[],
  query: string,
  archived = false,
): Task[] {
  const words = query
    .trim()
    .toLocaleLowerCase('ru')
    .split(/\s+/)
    .filter(Boolean);
  const names = new Map(projects.map((p) => [p.id, p.name]));
  return tasks
    .filter(
      (t) =>
        t.archived === archived &&
        words.every((w) =>
          [
            t.title,
            t.note,
            t.waitingFor,
            names.get(t.projectId ?? ''),
            ...t.checklist.map((i) => i.text),
          ]
            .join(' ')
            .toLocaleLowerCase('ru')
            .includes(w),
        ),
    )
    .toSorted(byOrder);
}
// The one group an active task belongs to, in the accepted priority order:
// selected by the owner, new from an agent, due, follow-up due; or none.
function focusGroupOf(t: Task, today: string): FocusGroup['id'] | undefined {
  if (t.archived || t.status === 'done') return undefined;
  if (t.focus) return 'selected';
  if (isAgentActor(t.createdBy) && !t.ownerTouchedAt) return 'new';
  if (t.due && t.due <= today) return 'due';
  if (t.status === 'waiting' && t.followUp && t.followUp <= today)
    return 'follow-ups';
  return undefined;
}
const groupOrder = (id: FocusGroup['id']) => (a: Task, b: Task) => {
  if (id === 'due')
    return compareStrings(a.due ?? '', b.due ?? '') || byOrder(a, b);
  if (id === 'follow-ups')
    return compareStrings(a.followUp ?? '', b.followUp ?? '') || byOrder(a, b);
  return byOrder(a, b);
};
export function focusGroups(tasks: Task[], today: string): FocusGroup[] {
  const groups: FocusGroup[] = [
    { id: 'selected', title: 'Выбрано мной', tasks: [] },
    { id: 'new', title: 'Новое от агентов', tasks: [] },
    { id: 'due', title: 'Пора сделать', tasks: [] },
    { id: 'follow-ups', title: 'Пора вернуться', tasks: [] },
  ];
  for (const t of tasks) {
    const id = focusGroupOf(t, today);
    if (id) groups.find((g) => g.id === id)!.tasks.push(t);
  }
  for (const g of groups) g.tasks.sort(groupOrder(g.id));
  return groups;
}
// The desk (plan 13, §3.3): a pure selector over the tasks. `current` is
// the focused task with the smallest key, `next` the two after it; `waiting`
// every waiting task, due follow-ups first; `recent` up to three tasks that
// left the desk in the last 14 days, newest first.
export function focusDesk(tasks: Task[], today: string): FocusDesk {
  const active = tasks.filter((t) => !t.archived && t.status !== 'done');
  const desk = active.filter((t) => t.focusKey !== null).toSorted(byFocusKey);
  const rank = (t: Task) => {
    if (!t.followUp) return 2;
    return t.followUp <= today ? 0 : 1;
  };
  const waiting = active
    .filter((t) => t.status === 'waiting')
    .toSorted(
      (a, b) =>
        rank(a) - rank(b) ||
        compareStrings(a.followUp ?? '', b.followUp ?? '') ||
        byOrder(a, b),
    );
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - LIMITS.deskRecentDays);
  const since = cutoff.toISOString().slice(0, 10);
  const recent = active
    .filter(
      (t) =>
        t.focusKey === null &&
        t.focusLeftAt !== null &&
        t.focusLeftAt.slice(0, 10) >= since,
    )
    .toSorted(
      (a, b) => compareStrings(b.focusLeftAt!, a.focusLeftAt!) || byOrder(a, b),
    )
    .slice(0, LIMITS.deskRecent);
  return {
    current: desk[0] ?? null,
    next: desk.slice(1, 1 + LIMITS.deskNext),
    waiting,
    recent,
    counts: {
      focus: desk.length,
      parked: active.filter((t) => t.status === 'todo' && t.focusKey === null)
        .length,
      waiting: waiting.length,
    },
  };
}
type TaskFilter = {
  q?: string;
  area?: AreaId;
  project?: string;
  status?: Status;
  archived?: boolean;
  focus?: boolean;
  today?: boolean;
  hasFollowUp?: boolean;
};
export function queryTasks(
  tasks: Task[],
  projects: Project[],
  filter: TaskFilter = {},
  today = todayInTimezone('Europe/Moscow'),
) {
  return searchTasks(
    tasks,
    projects,
    filter.q ?? '',
    filter.archived ?? false,
  ).filter(
    (t) =>
      (!filter.area || t.area === filter.area) &&
      (!filter.project ||
        projectFilterToId(filter.project) === undefined ||
        t.projectId === projectFilterToId(filter.project)) &&
      (!filter.status || t.status === filter.status) &&
      (filter.focus === undefined || t.focus === filter.focus) &&
      (filter.hasFollowUp === undefined ||
        Boolean(t.followUp) === filter.hasFollowUp) &&
      (!filter.today ||
        (t.status !== 'done' &&
          ((t.due !== null && t.due <= today) ||
            (t.status === 'waiting' &&
              t.followUp !== null &&
              t.followUp <= today)))),
  );
}
