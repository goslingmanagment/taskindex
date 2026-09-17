import type {
  AreaId,
  Command,
  Label,
  Project,
  Status,
  Task,
} from '@shared/model';
import type { Priority } from '@shared/labels';
import {
  columnPriority,
  columnStatus,
  type BoardColumn,
} from './board-columns';
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
  priority?: Priority;
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
      ...(task.priority ? { priority: task.priority } : {}),
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
/** One operation carries both the chosen column and its manual position. */
export function boardMoveCommand(
  task: Task,
  column: BoardColumn,
  before?: Task,
  after?: Task,
): Command {
  const priority = columnPriority(column);
  return {
    command: 'task.save',
    payload: {
      id: task.id,
      baseRevision: task.revision,
      status: columnStatus(column),
      ...(priority ? { fields: { priority } } : {}),
      ...(before
        ? { position: { before: before.id } }
        : after
          ? { position: { after: after.id } }
          : {}),
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
// A label with a revision exists and is renamed; without one it is created
// under the slug the dialog derived from its name.
export type LabelDraft = Pick<
  Label,
  'id' | 'name' | 'color' | 'description' | 'revision'
>;
export function labelSaveCommand(label: LabelDraft): Command {
  return label.revision
    ? {
        command: 'label.update',
        payload: {
          id: label.id,
          baseRevision: label.revision,
          name: label.name,
          color: label.color,
          description: label.description,
        },
      }
    : {
        command: 'label.create',
        payload: {
          id: label.id,
          name: label.name,
          color: label.color,
          description: label.description,
        },
      };
}
export const labelArchiveCommand = (label: Label): Command => ({
  command: 'label.archive',
  payload: { id: label.id, baseRevision: label.revision },
});
export const labelRestoreCommand = (label: Label): Command => ({
  command: 'label.restore',
  payload: { id: label.id, baseRevision: label.revision },
});
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
