import type { Project, Task, FocusGroup, AreaId, Status } from './model.js';
export const compareStrings = (a: string, b: string) =>
  a < b ? -1 : a > b ? 1 : 0;
export const byOrder = (a: Task, b: Task) =>
  compareStrings(a.orderKey, b.orderKey) || compareStrings(a.id, b.id);
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
export function dateLabel(value: string | null, today: string): string {
  if (!value) return '';
  if (value === today) return 'Сегодня';
  const next = new Date(`${today}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  if (value === next.toISOString().slice(0, 10)) return 'Завтра';
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
    .format(new Date(`${value}T12:00:00Z`))
    .replace('.', '');
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
    .sort(byOrder);
}
export function focusGroups(tasks: Task[], today: string): FocusGroup[] {
  const groups: FocusGroup[] = [
    { id: 'selected', title: 'Выбрано мной', tasks: [] },
    { id: 'new', title: 'Новое от агентов', tasks: [] },
    { id: 'due', title: 'Пора сделать', tasks: [] },
    { id: 'follow-ups', title: 'Пора вернуться', tasks: [] },
  ];
  for (const t of tasks) {
    if (t.archived || t.status === 'done') continue;
    const i = t.focus
      ? 0
      : t.createdBy.startsWith('agent:') && !t.ownerTouchedAt
        ? 1
        : t.due && t.due <= today
          ? 2
          : t.status === 'waiting' && t.followUp && t.followUp <= today
            ? 3
            : -1;
    if (i >= 0) groups[i]!.tasks.push(t);
  }
  for (const g of groups)
    g.tasks.sort((a, b) =>
      g.id === 'due'
        ? compareStrings(a.due ?? '', b.due ?? '') || byOrder(a, b)
        : g.id === 'follow-ups'
          ? compareStrings(a.followUp ?? '', b.followUp ?? '') || byOrder(a, b)
          : byOrder(a, b),
    );
  return groups;
}
export type TaskFilter = {
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
        filter.project === 'all' ||
        (filter.project === 'none'
          ? t.projectId === null
          : t.projectId === filter.project)) &&
      (!filter.status || t.status === filter.status) &&
      (filter.focus === undefined || t.focus === filter.focus) &&
      (filter.hasFollowUp === undefined ||
        Boolean(t.followUp) === filter.hasFollowUp) &&
      (!filter.today ||
        (t.status !== 'done' &&
          ((t.due && t.due <= today) ||
            (t.status === 'waiting' && t.followUp && t.followUp <= today)))),
  );
}
