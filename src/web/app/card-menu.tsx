import { Menu } from '@base-ui/react/menu';
import { ArrowUp, Archive, Star } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Task } from '@shared/model';
import { TASK_STATES as STATUSES, visibleStatus } from './board-columns';
import { PRIORITIES } from '@shared/labels';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
          <DropdownMenuContent align="end" className="card-actions">
            {task && <CardActions task={task} pending={isPending(task.id)} />}
          </DropdownMenuContent>
        );
      }}
    </Menu.Root>
  );
}

// Icons, status dots and priority marks differ in width; one fixed slot keeps
// every caption on the same vertical.
const Lead = ({ children }: { children: ReactNode }) => (
  <span className="menu-lead">{children}</span>
);

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
        <Lead>
          <Star />
        </Lead>
        {task.focus ? 'Убрать из фокуса' : 'В фокус'}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {/* The current value carries a check mark; a greyed row read as an
          unavailable action. */}
      <DropdownMenuRadioGroup value={visibleStatus(task.status)}>
        {STATUSES.map((status) => (
          <DropdownMenuRadioItem
            key={status.id}
            value={status.id}
            disabled={pending}
            closeOnClick
            onClick={() => {
              if (status.id !== task.status)
                runCardAction(setStatus(task, status.id));
            }}
          >
            <Lead>
              <span
                className="status-dot"
                style={{ background: status.color }}
              />
            </Lead>
            {status.name}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuRadioGroup value={task.priority}>
        {PRIORITIES.map((level) => (
          <DropdownMenuRadioItem
            key={level.id}
            value={level.id}
            disabled={pending}
            closeOnClick
            onClick={() => {
              if (level.id !== task.priority)
                runCardAction(
                  saveFields(
                    task,
                    { priority: level.id },
                    `Приоритет: ${level.name}`,
                  ),
                );
            }}
          >
            <Lead>
              <span className={`priority-mark priority-${level.id}`}>
                {level.name}
              </span>
            </Lead>
            {level.hint}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={pending}
        onClick={() => runCardAction(moveToQueueTop(task))}
      >
        <Lead>
          <ArrowUp />
        </Lead>
        В начало очереди
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={pending}
        onClick={() => runCardAction(toggleArchive(task))}
      >
        <Lead>
          <Archive />
        </Lead>
        {task.archived ? 'Вернуть из архива' : 'В архив'}
      </DropdownMenuItem>
    </>
  );
}
