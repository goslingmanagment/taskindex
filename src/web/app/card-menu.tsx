import { Menu } from '@base-ui/react/menu';
import { ArrowUp, Archive, Star } from 'lucide-react';
import { STATUSES, type Task } from '@shared/model';
import { PRIORITIES } from '@shared/labels';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu';
import { toast } from '../ui/toast';
import { useWorkspaceCommands } from './use-workspace-commands';

export function runCardAction(promise: Promise<unknown>) {
  void promise.catch((error) =>
    toast.add({
      title: error instanceof Error ? error.message : 'Не удалось сохранить.',
      type: 'error',
    }),
  );
}

// A board has one open menu. Its popup and menu state live outside DndContext,
// so drag updates do not traverse hundreds of closed menu trees (TI-085).
export function TaskCardMenu({
  handle,
  tasks,
  isPending,
}: {
  handle: Menu.Handle<string>;
  tasks: Task[];
  isPending: (id: string) => boolean;
}) {
  return (
    <Menu.Root handle={handle}>
      {({ payload }) => {
        const task = tasks.find((item) => item.id === payload);
        return (
          <DropdownMenuContent align="end">
            {task && <CardActions task={task} pending={isPending(task.id)} />}
          </DropdownMenuContent>
        );
      }}
    </Menu.Root>
  );
}

function CardActions({ task, pending }: { task: Task; pending: boolean }) {
  const { saveFields, setStatus, moveToQueueTop, toggleArchive } =
    useWorkspaceCommands();
  return (
    <>
      <DropdownMenuItem
        disabled={pending || task.archived || task.status === 'done'}
        onClick={() =>
          runCardAction(
            saveFields(
              task,
              { focus: !task.focus },
              task.focus ? 'Задача убрана из фокуса' : 'Задача в фокусе',
            ),
          )
        }
      >
        <Star />
        {task.focus ? 'Убрать из фокуса' : 'В фокус'}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {STATUSES.map((status) => (
        <DropdownMenuItem
          key={status.id}
          disabled={pending || task.status === status.id}
          onClick={() => runCardAction(setStatus(task, status.id))}
        >
          <span className="status-dot" style={{ background: status.color }} />
          {status.name}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      {PRIORITIES.map((level) => (
        <DropdownMenuItem
          key={level.id}
          disabled={pending || task.priority === level.id}
          onClick={() =>
            runCardAction(
              saveFields(
                task,
                { priority: level.id },
                `Приоритет: ${level.name}`,
              ),
            )
          }
        >
          <span className={`priority-mark priority-${level.id}`}>
            {level.name}
          </span>
          {level.hint}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={pending}
        onClick={() => runCardAction(moveToQueueTop(task))}
      >
        <ArrowUp />В начало очереди
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={pending}
        onClick={() => runCardAction(toggleArchive(task))}
      >
        <Archive />
        {task.archived ? 'Вернуть из архива' : 'В архив'}
      </DropdownMenuItem>
    </>
  );
}
