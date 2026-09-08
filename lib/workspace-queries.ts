import type { Project, Task } from './workspace';

export function byRank(a: Task, b: Task) {
  return a.rank - b.rank || a.id.localeCompare(b.id);
}

export function searchTasks(
  tasks: Task[],
  projects: Project[],
  query: string,
  showDemo: boolean,
  archived = false,
) {
  const words = query
    .trim()
    .toLocaleLowerCase('ru')
    .split(/\s+/)
    .filter(Boolean);
  const names = new Map(projects.map((p) => [p.id, p.name]));
  return tasks
    .filter((task) => {
      if (task.archived !== archived || (!showDemo && task.demo)) return false;
      const text = [
        task.title,
        task.note,
        task.waitingFor,
        names.get(task.projectId),
        ...task.checklist.map((item) => item.text),
      ]
        .join(' ')
        .toLocaleLowerCase('ru');
      return words.every((word) => text.includes(word));
    })
    .sort(byRank);
}

export function focusGroups(tasks: Task[], today: string, showDemo: boolean) {
  const active = tasks.filter(
    (task) =>
      !task.archived && task.status !== 'done' && (showDemo || !task.demo),
  );
  const selected = active.filter((task) => task.focus).sort(byRank);
  const remaining = active.filter((task) => !task.focus);
  const due = remaining
    .filter((task) => task.due && task.due <= today)
    .sort((a, b) => a.due.localeCompare(b.due) || byRank(a, b));
  const dueIds = new Set(due.map((task) => task.id));
  const followUps = remaining
    .filter(
      (task) =>
        !dueIds.has(task.id) &&
        task.status === 'waiting' &&
        task.followUp &&
        task.followUp <= today,
    )
    .sort((a, b) => a.followUp.localeCompare(b.followUp) || byRank(a, b));
  return [
    { id: 'selected', title: 'Выбрано мной', tasks: selected },
    { id: 'due', title: 'Пора сделать', tasks: due },
    { id: 'follow-ups', title: 'Пора вернуться', tasks: followUps },
  ];
}
