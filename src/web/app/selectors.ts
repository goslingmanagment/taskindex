import type { DomainEvent, Project, Task } from '@shared/model';
import { byOrder, focusGroups, searchTasks } from '@shared/queries';
import type { LocationState } from './url';
// TI-059 (план 07, шаг 10): что видно на экране — чистая функция от данных,
// адреса и «сегодня». Ни store, ни DOM: то же самое решение принимает тест.
type TaskSource = { tasks: Task[]; projects: Project[] };
/** `all` и `none` — не идентификаторы, а режимы списка направлений. */
export const isProjectId = (value: string) =>
  value !== 'all' && value !== 'none';
/**
 * Направление из адреса, если оно есть в этой области. Раньше несуществующий
 * идентификатор переписывал URL из эффекта; теперь он просто не выбирается,
 * а адрес нормализуется при следующем переходе.
 */
export function effectiveProject(
  location: Pick<LocationState, 'area' | 'project'>,
  projects: Project[],
): string {
  if (!isProjectId(location.project)) return location.project;
  return projects.some(
    (p) => p.id === location.project && p.area === location.area,
  )
    ? location.project
    : 'all';
}
/** Задачи выбранной области, архива и направления — без фильтра «На сегодня». */
export function selectContextualTasks(
  data: TaskSource,
  location: LocationState,
): Task[] {
  const project = effectiveProject(location, data.projects);
  return data.tasks.filter(
    (t) =>
      t.area === location.area &&
      t.archived === location.archive &&
      (project === 'all' ||
        t.projectId === (project === 'none' ? null : project)),
  );
}
const dueToday = (t: Task, today: string) =>
  t.status !== 'done' &&
  ((t.due !== null && t.due <= today) ||
    (t.status === 'waiting' && t.followUp !== null && t.followUp <= today));
/** Список карточек текущего экрана: поиск, Focus или доска области. */
export function selectVisibleTasks(
  data: TaskSource,
  location: LocationState,
  today: string,
): Task[] {
  if (location.q.trim().length > 0)
    return searchTasks(
      data.tasks,
      data.projects,
      location.q,
      location.archiveSearch,
    );
  if (location.focus)
    return focusGroups(data.tasks, today).flatMap((g) => g.tasks);
  return selectContextualTasks(data, location)
    .filter((t) => !location.today || dueToday(t, today))
    .toSorted(byOrder);
}
/** Активные задачи, созданные агентом и ещё не тронутые владельцем. */
export function newFromAgentsCount(tasks: Task[]): number {
  return tasks.filter(
    (t) =>
      t.createdBy.startsWith('agent:') &&
      !t.ownerTouchedAt &&
      !t.archived &&
      t.status !== 'done',
  ).length;
}
/**
 * TI-063 (план 07, §3.6): позиция журнала, на которой в последний раз менялась
 * именно эта задача. Обсуждение перечитывает комментарии и историю по ней, а не
 * по общему `seq`, поэтому чужие изменения его не трогают.
 */
export function latestSeqForTask(
  events: readonly DomainEvent[],
  taskId: string,
): number {
  let seq = 0;
  for (const event of events)
    if (
      (event.entityId === taskId || event.taskId === taskId) &&
      event.seq > seq
    )
      seq = event.seq;
  return seq;
}
