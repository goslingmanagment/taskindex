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
import { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AREAS, STATUSES, type Project, type Task } from '@shared/model';
import { dateLabel } from '@shared/queries';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu';
import { toast } from '../ui/toast';
import { useWorkspaceCommands } from './use-workspace-commands';
import { useNavigation } from './navigation';
type TaskCardProps = {
  task: Task;
  project: Project | undefined;
  today: string;
  /** Экран показывает задачи всех областей: подписываем область и состояние. */
  showContext: boolean;
  pending: boolean;
  disabled: boolean;
};
function safely(promise: Promise<unknown>) {
  void promise.catch((error) =>
    toast.add({
      title: error instanceof Error ? error.message : 'Не удалось сохранить.',
      type: 'error',
    }),
  );
}
export const TaskCard = memo(function TaskCard(props: TaskCardProps) {
  const sortable = useSortable({
    id: props.task.id,
    disabled: props.disabled,
    data: { task: props.task },
  });
  return <TaskCardContent {...props} sortable={sortable} />;
});
export function TaskCardContent({
  task,
  project,
  today,
  showContext,
  pending,
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
  const { openTask } = useNavigation();
  return (
    <article
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform ?? null),
        transition,
      }}
      className={`task-card ${task.status === 'done' ? 'task-done' : ''} ${isDragging ? 'dragging' : ''}`}
    >
      {/* Оверлей вместо клика по `<article>`: сама карточка не фокусируется, а
          оверлей даёт одну цель для мыши, касания и фокуса. Он делит
          `listeners` dnd-kit, чтобы перенос начинался с любого места карточки;
          `onKeyDown={undefined}` снимает клавиатурный активатор dnd-kit — иначе
          Enter и пробел начинали бы перенос вместо открытия, а клавиатурный
          перенос живёт на отдельной ручке ниже. */}
      <button
        {...listeners}
        type="button"
        onKeyDown={undefined}
        className="card-open"
        data-task-open={task.id}
        onClick={() => openTask(task.id)}
        aria-label={'Открыть: ' + task.title}
      />
      <TaskCardBody
        task={task}
        project={project}
        today={today}
        showContext={showContext}
        pending={pending}
      />
      {!disabled && sortable && (
        <button
          type="button"
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
// SortableContext updates every item's drag bindings when a sibling is added.
// Keep that work outside the menu and labels of an unchanged card (TI-083).
const TaskCardBody = memo(function TaskCardBody({
  task,
  project: p,
  today,
  showContext,
  pending,
}: Omit<TaskCardProps, 'disabled'>) {
  const { location } = useNavigation();
  const { setStatus, toggleArchive, saveFields, moveToQueueTop } =
    useWorkspaceCommands();
  return (
    <>
      <div className="task-title-row">
        <button
          type="button"
          disabled={pending}
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
              task.archived
                ? toggleArchive(task, 'Задача возвращена')
                : setStatus(
                    task,
                    task.status === 'done' ? 'todo' : 'done',
                    task.status === 'done'
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
        {showContext && (
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
        {p && (showContext || location.project !== p.id) && (
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
            disabled={pending || task.archived || task.status === 'done'}
            onClick={() =>
              safely(
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
          {STATUSES.map((s) => (
            <DropdownMenuItem
              key={s.id}
              disabled={pending || task.status === s.id}
              onClick={() => safely(setStatus(task, s.id))}
            >
              <span className="status-dot" style={{ background: s.color }} />
              {s.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={pending}
            onClick={() => safely(moveToQueueTop(task))}
          >
            <ArrowUp />В начало очереди
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={pending}
            onClick={() => safely(toggleArchive(task))}
          >
            <Archive />
            {task.archived ? 'Вернуть из архива' : 'В архив'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
});
