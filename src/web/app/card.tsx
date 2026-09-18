import {
  CircleCheck,
  Check,
  Undo2,
  Star,
  ListChecks,
  GripVertical,
} from 'lucide-react';
import { memo, useState, type CSSProperties } from 'react';
import { Menu } from '@base-ui/react/menu';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AREAS, type Label, type Project, type Task } from '@shared/model';
import {
  TASK_STATES as STATUSES,
  boardColumn,
  visibleStatus,
} from './board-columns';
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
  /** The board and its drag overlay share one appearance. */
  boardAppearance: boolean;
  /** The label catalogue of the workspace: names and colours of the chips. */
  catalogue: readonly Label[];
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
  boardAppearance,
  catalogue,
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
      className={`task-card ${boardAppearance ? 'board-card' : ''} ${task.status === 'done' ? 'task-done' : ''} ${isDragging ? 'dragging' : ''}`}
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
        showProject={showProject}
        catalogue={catalogue}
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
  catalogue,
  pending,
  menu,
}: Omit<TaskCardProps, 'disabled' | 'boardAppearance'>) {
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
        {/* The column already names the priority: the chip marks only a task
            that left its column (doing, done) or a screen without columns. */}
        {task.priority !== 'p2' &&
          (showContext || boardColumn(task) !== task.priority) && (
            <span
              className={`priority-mark ${task.priority === 'p1' ? 'priority-p1' : 'priority-p3'}`}
              aria-label={`Приоритет ${task.priority.toUpperCase()}`}
            >
              {task.priority.toUpperCase()}
            </span>
          )}
        <h3>{task.title}</h3>
      </div>
      {/* Одна строка под заголовком (2026-09-18): срок и чеклист первыми, за
          ними чипы направления и меток, подпись автора у правого края. */}
      <div className="card-footer">
        {showContext && (
          <span className="task-context">
            {AREAS.find((a) => a.id === task.area)?.name} ·{' '}
            {STATUSES.find((s) => s.id === visibleStatus(task.status))?.name}
            {task.archived ? ' · Архив' : ''}
          </span>
        )}
        {task.due && (
          <span
            className={
              'due-label ' +
              (task.status !== 'done' && task.due < today ? 'overdue' : '')
            }
          >
            {task.due < today && task.status !== 'done' ? 'Срок: ' : ''}
            {dateLabel(task.due, today)}
          </span>
        )}
        {task.checklist.length > 0 && (
          <span className="checklist-mark">
            <ListChecks size={13} />
            {task.checklist.filter((c) => c.done).length}/
            {task.checklist.length}
          </span>
        )}
        {task.focus && task.status !== 'done' && !task.archived && (
          <span className="focus-mark">
            <Star size={13} fill="currentColor" />В фокусе
          </span>
        )}
        {p && showProject && (
          <span
            className="project-tag"
            style={{ '--chip-color': p.color } as CSSProperties}
          >
            <span className="tag-dot" style={{ background: p.color }} />
            {p.name}
          </span>
        )}
        {task.labels.map((id) => {
          const label = catalogue.find((item) => item.id === id);
          return (
            <span key={id} className="label-chip" data-label={id}>
              {label?.name ?? id}
            </span>
          );
        })}
        {task.createdBy.startsWith('agent:') && !task.ownerTouchedAt && (
          <span className="agent-mark">{task.createdByLabel}</span>
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
