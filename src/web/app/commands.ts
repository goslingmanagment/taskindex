import type { AreaId, Command, Project, Status, Task } from '@shared/model';
// TI-059 (план 07, шаг 9): единственное место, где предметное намерение
// превращается в `Command`. Билдеры чистые: ни store, ни сети, ни React, —
// поэтому их проверяет `tests/web/commands.test.ts` схемой команды.
/** Поля карточки, которые правит владелец; порядок задаёт порядок в payload. */
const editableFields = [
  'area',
  'projectId',
  'title',
  'note',
  'due',
  'waitingFor',
  'followUp',
  'priority',
  'labels',
  'closes',
  'focus',
] as const;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export type NewTask = {
  id: string;
  area: AreaId;
  title: string;
  status?: Status;
  projectId?: string | null;
  focus?: boolean;
};
export function taskCreateCommand(task: NewTask): Command {
  return {
    command: 'task.create',
    payload: {
      id: task.id,
      area: task.area,
      title: task.title,
      projectId: task.projectId ?? null,
      ...(task.status ? { status: task.status } : {}),
      ...(task.focus ? { focus: true } : {}),
    },
  };
}
/** Отправляются только поля, которые отличаются от подтверждённой базы. */
export function taskSaveCommand(task: Task, base: Task): Command {
  const fields: Record<string, unknown> = {};
  for (const field of editableFields)
    if (!same(task[field], base[field])) fields[field] = task[field];
  return {
    command: 'task.save',
    payload: {
      id: task.id,
      baseRevision: base.revision,
      ...(Object.keys(fields).length ? { fields } : {}),
      ...(task.status !== base.status ? { status: task.status } : {}),
      ...(!same(task.checklist, base.checklist)
        ? { checklist: task.checklist }
        : {}),
    },
  };
}
export function taskMoveCommand(
  task: Task,
  status: Status,
  before?: Task,
  after?: Task,
): Command {
  return {
    command: 'task.move',
    payload: {
      id: task.id,
      baseRevision: task.revision,
      status,
      ...(before ? { before: before.id } : {}),
      ...(after ? { after: after.id } : {}),
    },
  };
}
export function taskArchiveCommand(task: Task): Command {
  return {
    command: 'task.archive',
    payload: { id: task.id, baseRevision: task.revision },
  };
}
export function taskRestoreCommand(task: Task): Command {
  return {
    command: 'task.restore',
    payload: { id: task.id, baseRevision: task.revision },
  };
}
/** TI-078: место на столе Focus; `first` — в начало, остальные — рядом с соседом. */
export function taskFocusCommand(
  task: Task,
  position: { first: true } | { before: string } | { after: string },
): Command {
  return {
    command: 'task.update',
    payload: {
      id: task.id,
      baseRevision: task.revision,
      focus: true,
      focusPosition: position,
    },
  };
}
/** Отметка шага на столе: отдельная команда, а не сохранение всей карточки. */
export function checklistToggleCommand(
  task: Task,
  itemId: string,
  done: boolean,
): Command {
  return {
    command: 'checklist.update',
    payload: { taskId: task.id, baseRevision: task.revision, itemId, done },
  };
}
export function projectSaveCommand(project: Project): Command {
  return project.revision
    ? {
        command: 'project.update',
        payload: {
          id: project.id,
          baseRevision: project.revision,
          name: project.name,
          color: project.color,
          description: project.description,
        },
      }
    : {
        command: 'project.create',
        payload: {
          id: project.id,
          area: project.area,
          name: project.name,
          color: project.color,
          description: project.description,
        },
      };
}
export function commentAddCommand(
  taskId: string,
  id: string,
  text: string,
): Command {
  return { command: 'comment.add', payload: { taskId, id, text } };
}
export function commentRemoveCommand(commentId: string): Command {
  return { command: 'comment.remove', payload: { commentId } };
}
export function undoCommand(
  payload: { seq: number } | { operationId: string },
): Command {
  return { command: 'undo', payload };
}
