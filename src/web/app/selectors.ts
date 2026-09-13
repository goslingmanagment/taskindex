import type { DomainEvent, Project, Task } from '@shared/model';
import { byOrder, focusDesk, focusGroups, searchTasks } from '@shared/queries';
import type { LocationState } from './url';
// TI-059 (план 07, шаг 10): что видно на экране — чистая функция от данных,
// адреса и «сегодня». Ни store, ни DOM: то же самое решение принимает тест.
type TaskSource = { tasks: Task[]; projects: Project[] };
type TaskSelection = Pick<
  LocationState,
  'area' | 'project' | 'archive' | 'q' | 'archiveSearch' | 'focus' | 'today'
> & {
  /** The owner's preference applies only to the area's board and list. */
  hideP3?: boolean;
};
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
  location: Pick<LocationState, 'area' | 'project' | 'archive'>,
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
  location: TaskSelection,
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
    .filter((t) => !location.hideP3 || location.archive || t.priority !== 'p3')
    .toSorted(byOrder);
}
/** Tasks hidden by the P3 preference after the other screen filters. */
export function hiddenP3Count(
  data: TaskSource,
  location: TaskSelection,
  today: string,
): number {
  if (
    !location.hideP3 ||
    location.q.trim().length > 0 ||
    location.focus ||
    location.archive
  )
    return 0;
  return selectContextualTasks(data, location).filter(
    (task) =>
      (!location.today || dueToday(task, today)) && task.priority === 'p3',
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
/**
 * TI-078, TI-029: стол Focus по задачам пространства — тот же расчёт, что у
 * `GET /api/focus`. До первого снимка в store нет даты (`today === ''`), а
 * селектор строит из неё границу «недавно снятых», поэтому пустая дата
 * подменяется календарной датой браузера, а не роняет сайдбар.
 */
export function deskOf(
  tasks: Task[],
  today: string,
): ReturnType<typeof focusDesk> {
  return focusDesk(tasks, today || new Date().toISOString().slice(0, 10));
}
