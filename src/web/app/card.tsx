import {
  CircleCheck,
  Check,
  Undo2,
  Star,
  Clock3,
  CalendarDays,
  ListChecks,
  ArrowUp,
  Archive,
  GripVertical,
} from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu';
import { toast } from '../ui/toast';
import {
  AREAS,
  STATUSES,
  dateLabel,
  type Task,
  type Status,
  type WorkspaceData,
} from '../lib/workspace';
type TaskCardProps = {
  task: Task;
  data: WorkspaceData;
  projectId: string;
  globalView: boolean;
  pending: boolean;
  today: string;
  disabled: boolean;
  setSelected: (task: Task) => void;
  change: (
    task: Task,
    patch: Partial<Task>,
    message: string,
  ) => Promise<unknown>;
  move: (
    task: Task,
    status: Status,
    before?: Task,
    after?: Task,
  ) => Promise<unknown>;
  first: (task: Task) => Promise<unknown>;
};
function safely(promise: Promise<unknown>) {
  void promise.catch((error) =>
    toast.add({
      title: error instanceof Error ? error.message : 'Не удалось сохранить.',
      type: 'error',
    }),
  );
}
export function TaskCard(props: TaskCardProps) {
  const sortable = useSortable({
    id: props.task.id,
    disabled: props.disabled,
    data: { task: props.task },
  });
  return <TaskCardContent {...props} sortable={sortable} />;
}
export function TaskCardContent({
  task,
  data,
  projectId,
  globalView,
  pending,
  today,
  setSelected,
  change,
  move,
  first,
  disabled,
  sortable,
}: TaskCardProps & { sortable?: ReturnType<typeof useSortable> }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = sortable ?? {};
  const p = data.projects.find((p) => p.id === task.projectId);
  return (
    <article
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform ?? null),
        transition,
      }}
      className={`task-card ${task.status === 'done' ? 'task-done' : ''} ${isDragging ? 'dragging' : ''}`}
    >
      <button
        {...listeners}
        onKeyDown={undefined}
        className="card-open"
        data-task-open={task.id}
        onClick={() => setSelected(task)}
        aria-label={'Открыть: ' + task.title}
      />
      <div className="task-title-row">
        <button
          disabled={!!pending}
          className="complete-circle"
          aria-label={
            task.archived
              ? 'Вернуть задачу из архива'
              : task.status === 'done'
                ? 'Вернуть в очередь'
                : 'Завершить: ' + task.title
          }
          onClick={() =>
            safely(
              change(
                task,
                task.archived
                  ? { archived: false }
                  : { status: task.status === 'done' ? 'todo' : 'done' },
                task.archived
                  ? 'Задача возвращена'
                  : task.status === 'done'
                    ? 'Возвращено в очередь'
                    : 'Задача готова',
              ),
            )
          }
        >
          {task.archived ? (
            <Undo2 size={16} />
          ) : task.status === 'done' ? (
            <CircleCheck size={19} />
          ) : (
            <Check size={12} className="check-hover" />
          )}
        </button>
        <h3>{task.title}</h3>
      </div>
      {task.status === 'waiting' && task.waitingFor && (
        <p className="waiting-line">
          <Clock3 size={14} />
          {task.waitingFor}
        </p>
      )}
      <div className="card-label-row">
        {globalView && (
          <span className="task-context">
            {AREAS.find((a) => a.id === task.area)?.name} ·{' '}
            {STATUSES.find((s) => s.id === task.status)?.name}
            {task.archived ? ' · Архив' : ''}
          </span>
        )}
        {task.focus && task.status !== 'done' && !task.archived && (
          <span className="focus-mark">
            <Star size={13} fill="currentColor" />В фокусе
          </span>
        )}
        {p && (globalView || projectId !== p.id) && (
          <span className="project-tag">
            <span className="tag-dot" style={{ background: p.color }} />
            {p.name}
          </span>
        )}
        {task.createdBy.startsWith('agent:') && !task.ownerTouchedAt && (
          <span className="agent-mark">от {task.createdByLabel}</span>
        )}
      </div>
      <div className="card-meta">
        {task.due && (
          <span
            className={
              'due-label ' +
              (task.status !== 'done' && task.due < today ? 'overdue' : '')
            }
          >
            <CalendarDays size={14} />
            {task.due < today && task.status !== 'done' ? 'Срок: ' : ''}
            {dateLabel(task.due, today)}
          </span>
        )}
        {task.status === 'waiting' && task.followUp && (
          <span
            className={
              'check-date ' + (task.followUp <= today ? 'check-now' : '')
            }
          >
            <Clock3 size={14} />
            Вернуться {dateLabel(task.followUp, today).toLowerCase()}
          </span>
        )}
        {task.checklist.length > 0 && (
          <span>
            <ListChecks size={15} />
            {task.checklist.filter((c) => c.done).length}/
            {task.checklist.length}
          </span>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              className="card-menu"
              size="icon"
              aria-label={'Действия: ' + task.title}
            />
          }
        >
          ···
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={!!pending || task.archived || task.status === 'done'}
            onClick={() =>
              safely(
                change(
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
          {STATUSES.map((s) => (
            <DropdownMenuItem
              key={s.id}
              disabled={!!pending || task.status === s.id}
              onClick={() => safely(move(task, s.id))}
            >
              <span className="status-dot" style={{ background: s.color }} />
              {s.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!!pending}
            onClick={() => safely(first(task))}
          >
            <ArrowUp />В начало очереди
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!!pending}
            onClick={() =>
              safely(
                change(
                  task,
                  { archived: !task.archived },
                  task.archived ? 'Задача возвращена' : 'Задача в архиве',
                ),
              )
            }
          >
            <Archive />
            {task.archived ? 'Вернуть из архива' : 'В архив'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {!disabled && sortable && (
        <button
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          className="drag-handle"
          aria-label={'Перетащить: ' + task.title}
        >
          <GripVertical size={14} />
        </button>
      )}
    </article>
  );
}
