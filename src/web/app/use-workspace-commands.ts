import { useCallback, useMemo } from 'react';
import type { z } from 'zod';
import type {
  Command,
  OperationSuccess,
  Project,
  Status,
  Task,
} from '@shared/model';
import { projectSchema, taskSchema } from '@shared/domain-schemas';
import { byOrder } from '@shared/queries';
import { toast } from '../ui/toast';
import { workspaceStore } from './store';
import {
  projectSaveCommand,
  boardMoveCommand,
  taskArchiveCommand,
  taskCreateCommand,
  taskMoveCommand,
  taskRestoreCommand,
  taskSaveCommand,
  undoCommand,
  type NewTask,
} from './commands';
import { BOARD_COLUMNS, type BoardColumn } from './board-columns';
// TI-059 (план 07, шаг 11): отправка команд и уведомления об успехе — один хук
// вместо восьми функций внутри `shell.tsx`. Общий `change(task, patch)` разошёлся
// на три явных действия: по патчу нельзя было понять, какая команда уйдёт.
/** Сообщение об успехе с кнопкой «Отменить», если операция дала события. */
export function notify(result: OperationSuccess, message: string) {
  toast.add({
    title: message,
    type: 'success',
    timeout: 6500,
    ...(result.events.length
      ? {
          actionProps: {
            children: 'Отменить',
            onClick: () => {
              void workspaceStore
                .submit(undoCommand({ operationId: result.operationId }))
                .then(() =>
                  toast.add({ title: 'Действие отменено', type: 'info' }),
                )
                .catch((error: Error) =>
                  toast.add({ title: error.message, type: 'error' }),
                );
            },
          },
        }
      : {}),
  });
}
// TI-005: запись из ответа проходит схему, а не приводится кастом.
function record<T>(result: OperationSuccess, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(result.results[0]?.record);
  if (!parsed.success) throw new Error('Сервер не вернул сохранённую запись.');
  return parsed.data;
}
export function useWorkspaceCommands() {
  const execute = useCallback(async (command: Command, message: string) => {
    const result = await workspaceStore.submit(command);
    notify(result, message);
    return result;
  }, []);
  return useMemo(() => {
    const statusMessage = (status: Status) =>
      `Задача → ${
        status === 'todo'
          ? 'Очередь'
          : status === 'doing'
            ? 'В работе'
            : status === 'waiting'
              ? 'Очередь'
              : 'Готово'
      }`;
    const move = (task: Task, status: Status, before?: Task, after?: Task) =>
      execute(
        taskMoveCommand(task, status, before, after),
        statusMessage(status),
      );
    return {
      execute,
      move: (task: Task, column: BoardColumn, before?: Task, after?: Task) =>
        execute(
          boardMoveCommand(task, column, before, after),
          `Задача → ${BOARD_COLUMNS.find((item) => item.id === column)!.name}`,
        ),
      /** Смена состояния из карточки и меню: всегда `task.move`. */
      setStatus: (task: Task, status: Status, message?: string) =>
        execute(
          taskMoveCommand(task, status),
          message ?? statusMessage(status),
        ),
      toggleArchive: (task: Task, message?: string) =>
        execute(
          task.archived ? taskRestoreCommand(task) : taskArchiveCommand(task),
          message ?? (task.archived ? 'Задача возвращена' : 'Задача в архиве'),
        ),
      /** Предметные поля карточки: `task.save` с одними изменившимися полями. */
      saveFields: (task: Task, patch: Partial<Task>, message: string) =>
        execute(taskSaveCommand({ ...task, ...patch }, task), message),
      saveTask: async (task: Task, base: Task, operationId?: string) => {
        const result = await workspaceStore.submit(
          taskSaveCommand(task, base),
          operationId,
        );
        return { task: record(result, taskSchema), result };
      },
      createTask: async (task: NewTask, operationId?: string) => {
        const result = await workspaceStore.submit(
          taskCreateCommand(task),
          operationId,
        );
        return { task: record(result, taskSchema), result };
      },
      saveProject: async (project: Project, operationId?: string) => {
        const result = await workspaceStore.submit(
          projectSaveCommand(project),
          operationId,
        );
        return record(result, projectSchema);
      },
      /** «В начало очереди»: перед первой задачей очереди этой области. */
      moveToQueueTop: (task: Task) => {
        // Commands are actions, not workspace subscriptions. Read the current
        // queue when clicked, including tasks received since this card rendered.
        const before = workspaceStore
          .getSnapshot()
          .data.tasks.filter(
            (t) =>
              t.area === task.area &&
              t.status === 'todo' &&
              t.priority === task.priority &&
              !t.archived &&
              t.id !== task.id,
          )
          .toSorted(byOrder)[0];
        return move(task, 'todo', before);
      },
    };
  }, [execute]);
}
