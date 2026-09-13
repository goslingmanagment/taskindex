import {
  CircleCheck,
  Check,
  Undo2,
  Star,
  Clock3,
  CalendarDays,
  ListChecks,
  GripVertical,
} from 'lucide-react';
import { memo, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AREAS, STATUSES, type Project, type Task } from '@shared/model';
import { LABELS } from '@shared/labels';
import { dateLabel } from '@shared/queries';
import { Button } from '../ui/button';
import { runCardAction as safely } from './card-menu';
import { useWorkspaceCommands } from './use-workspace-commands';
import { useOpenTask } from './navigation';
type TaskCardProps = {
  task: Task;
  project: Project | undefined;
  today: string;
  /** Экран показывает задачи всех областей: подписываем область и состояние. */
  showContext: boolean;
  showProject: boolean;
  pending: boolean;
  disabled: boolean;
  menu: Menu.Handle<string>;
};
export const TaskCard = memo(function TaskCard(props: TaskCardProps) {
  // Search and archive cards have no drag interaction. Even a disabled
  // useSortable registers a container and subscribes to every drag (TI-085).
  return props.showContext || props.task.archived ? (
    <TaskCardContent {...props} />
  ) : (
    <SortableTaskCard {...props} />
  );
});
type DragBindings = Partial<
  Pick<
    ReturnType<typeof useSortable>,
    | 'attributes'
    | 'listeners'
    | 'setNodeRef'
    | 'setActivatorNodeRef'
    | 'transition'
    | 'isDragging'
  >
> & { transform?: string };
function SortableTaskCard(props: TaskCardProps) {
  const sortable = useSortable({
    id: props.task.id,
    disabled: props.disabled,
    data: { task: props.task },
  });
  const offset = sortable.transform;
  const transform = CSS.Transform.toString(
    offset &&
      (offset.x || offset.y || offset.scaleX !== 1 || offset.scaleY !== 1)
      ? offset
      : null,
  );
  // The vertical strategy returns an identity transform for untouched cards.
  // Avoid adding transform/transition styles to every card at drag start.
  // Once displaced, keep DnD's transition for the animation back to its place.
  const [displaced, setDisplaced] = useState(false);
  if (transform && !displaced) setDisplaced(true);
  return (
    <TaskCardContent
      {...props}
      attributes={sortable.attributes}
      listeners={sortable.listeners}
      setNodeRef={sortable.setNodeRef}
      setActivatorNodeRef={sortable.setActivatorNodeRef}
      transform={transform}
      transition={displaced ? sortable.transition : undefined}
      isDragging={sortable.isDragging}
    />
  );
}
// Only changed drag bindings cross this boundary. An unchanged card does not
// rerender its buttons and icons for every pointer movement.
export const TaskCardContent = memo(function TaskCardContent({
  task,
  project,
  today,
  showContext,
  showProject,
  pending,
  disabled,
  menu,
  attributes,
  listeners,
  setNodeRef,
  setActivatorNodeRef,
  transform,
  transition,
  isDragging,
}: TaskCardProps & DragBindings) {
  const openTask = useOpenTask();
  return (
    <article
      ref={setNodeRef}
      style={{
        transform,
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
        title={task.closes ? `Закрывает проблему ${task.closes}` : undefined}
      />
      <TaskCardBody
        task={task}
        project={project}
        today={today}
        showContext={showContext}
        showProject={showProject}
        pending={pending}
        menu={menu}
      />
      {!disabled && attributes && (
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
});
// SortableContext updates every item's drag bindings when a sibling is added.
// Keep that work outside the menu and labels of an unchanged card (TI-083).
const TaskCardBody = memo(function TaskCardBody({
  task,
  project: p,
  today,
  showContext,
  showProject,
  pending,
  menu,
}: Omit<TaskCardProps, 'disabled'>) {
  const { setStatus, toggleArchive } = useWorkspaceCommands();
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
        {task.priority !== 'p2' && (
          <span
            className={`priority-mark ${task.priority === 'p1' ? 'priority-p1' : 'priority-p3'}`}
            aria-label={`Приоритет ${task.priority.toUpperCase()}`}
          >
            {task.priority.toUpperCase()}
          </span>
        )}
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
        {p && showProject && (
          <span className="project-tag">
            <span className="tag-dot" style={{ background: p.color }} />
            {p.name}
          </span>
        )}
        {task.labels.map((id) => {
          const label = LABELS.find((item) => item.id === id);
          return (
            <span key={id} className="label-chip" data-label={id}>
              <span
                className="tag-dot"
                style={{ background: label?.color ?? 'currentColor' }}
              />
              {label?.name ?? id}
            </span>
          );
        })}
        {task.closes && (
          <span className="closes-chip">
            закрывает <code>{task.closes}</code>
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
      <Menu.Trigger
        data-slot="dropdown-menu-trigger"
        handle={menu}
        payload={task.id}
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
      </Menu.Trigger>
    </>
  );
});
