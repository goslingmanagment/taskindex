import {
  type ReactNode,
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { LIMITS } from '@shared/limits';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCorners,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { Plus, X } from 'lucide-react';
import { STATUSES, type Task, type Status, type AreaId } from '@shared/model';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Empty, EmptyDescription } from '../ui/empty';
import { readDraft, writeDraft, clearDraft, subscribeDraft } from './drafts';
import { useIntent } from './use-draft';
import { workspaceStore } from './store';
import { toast } from '../ui/toast';
import { ApiError } from './api';
import type { NewTask } from './commands';
export function DragBoard({
  tasks,
  disabled,
  move,
  children,
  renderOverlay,
}: {
  tasks: Task[];
  disabled: boolean;
  move: (
    task: Task,
    status: Status,
    before?: Task,
    after?: Task,
  ) => Promise<unknown>;
  children: ReactNode;
  renderOverlay: (task: Task) => ReactNode;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeTask = tasks.find((task) => task.id === activeId);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 220, tolerance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const end = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    if (disabled || !over || active.id === over.id) return;
    const task = tasks.find((t) => t.id === active.id),
      target = tasks.find((t) => t.id === over.id);
    const status =
      target?.status ?? STATUSES.find((s) => `column-${s.id}` === over.id)?.id;
    if (!task || !status) return;
    const after =
      target &&
      task.status === target.status &&
      tasks.indexOf(task) < tasks.indexOf(target)
        ? target
        : undefined;
    void move(task, status, after ? undefined : target, after).catch(
      (error: Error) => toast.add({ title: error.message, type: 'error' }),
    );
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={({ active }) => setActiveId(String(active.id))}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={end}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            'Чтобы переместить задачу, нажмите пробел. Используйте стрелки. Пробел завершит перенос, Escape отменит.',
        },
      }}
    >
      {children}
      <DragOverlay dropAnimation={null} className="drag-overlay">
        {activeTask ? renderOverlay(activeTask) : null}
      </DragOverlay>
    </DndContext>
  );
}
function Column({
  status,
  disabled,
  children,
}: {
  status: Status;
  disabled: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${status}`,
    disabled,
  });
  return (
    <section
      ref={setNodeRef}
      className={`column column-${status} ${isOver ? 'drop-column' : ''}`}
    >
      {children}
    </section>
  );
}
type DraftTitle = { title: string };
function InlineCreate({
  area,
  projectId,
  status,
  onSave,
}: {
  area: AreaId;
  projectId: string;
  status: Status;
  onSave: (task: NewTask, operationId: string) => Promise<Task>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const key = `new/${area}/${projectId}/${status}`;
  const [generation] = useState(() => workspaceStore.getSnapshot().generation);
  // План 07, шаг 15: черновик читается подпиской, а не эффектом с тремя
  // `setState` — тот же ключ пишет диалог «Новая задача», и оба поля должны
  // показывать один текст.
  const stored = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeDraft(key, listener), [key]),
    useCallback(() => readDraft<DraftTitle>(key), [key]),
  );
  const own = stored && stored.generation === generation ? stored : null;
  const title = own?.fields.title ?? '';
  const foreign = stored && !own ? stored.fields.title : null;
  const [initial] = useState(() => {
    const draft = readDraft<DraftTitle>(key);
    const restored = draft?.generation === generation ? draft : null;
    return {
      entityId: restored?.id ?? crypto.randomUUID(),
      operationId: restored?.operationId ?? crypto.randomUUID(),
    };
  });
  const intent = useIntent(initial.operationId, initial.entityId);
  const persist = (value: string) =>
    writeDraft<DraftTitle>(key, {
      formatVersion: 1,
      generation,
      baseRevision: 0,
      fields: { title: value },
      id: intent.entity.current,
      operationId: intent.ref.current.operationId,
    });
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      intent.dispatch({ type: 'edit', signature: title.trim() });
      const sending = intent.dispatch({
        type: 'send',
        signature: title.trim(),
      });
      persist(title);
      await onSave(
        {
          id: intent.entity.current,
          area,
          projectId:
            projectId === 'all' || projectId === 'none' ? null : projectId,
          status,
          title: title.trim(),
        },
        sending.operationId,
      );
      intent.dispatch({ type: 'success' });
      clearDraft(key);
    } catch (error_) {
      intent.dispatch({
        type: 'reject',
        retryable: !(error_ instanceof ApiError) || error_.detail.retryable,
      });
      setError(
        error_ instanceof Error ? error_.message : 'Не удалось сохранить.',
      );
    } finally {
      setBusy(false);
    }
  };
  return open ? (
    <form
      className="inline-create"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {foreign && (
        <p className="form-error">Черновик от прежней версии базы: {foreign}</p>
      )}
      <Input
        ref={inputRef}
        disabled={busy}
        aria-label="Название новой задачи"
        placeholder="Что нужно сделать?"
        maxLength={LIMITS.taskTitle}
        value={title}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) setOpen(false);
        }}
        onChange={(e) => {
          if (e.target.value) persist(e.target.value);
          else clearDraft(key);
        }}
      />
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div>
        <Button disabled={busy || !title.trim()} type="submit">
          {busy ? 'Добавляем…' : 'Добавить'}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          disabled={busy}
          aria-label="Закрыть добавление"
          onClick={() => setOpen(false)}
        >
          <X />
        </Button>
      </div>
    </form>
  ) : (
    <Button
      variant="ghost"
      className="column-add"
      onClick={() => {
        setOpen(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      }}
    >
      <Plus />
      Добавить задачу
    </Button>
  );
}
export function Board({
  tasks,
  view,
  area,
  projectId,
  mode,
  filtered,
  renderTask,
  onCreate,
}: {
  tasks: Task[];
  view: 'board' | 'list';
  area: AreaId;
  projectId: string;
  /** Архив показывает те же колонки, но без переноса и без добавления. */
  mode: 'board' | 'archive';
  filtered: boolean;
  renderTask: (task: Task) => ReactNode;
  onCreate: (task: NewTask, operationId: string) => Promise<Task>;
}) {
  const archive = mode === 'archive';
  return (
    <div className={'kanban ' + (view === 'list' ? 'list-view' : '')}>
      {STATUSES.map((status) => {
        const column = tasks.filter((t) => t.status === status.id);
        return (
          <Column key={status.id} status={status.id} disabled={archive}>
            <div className="column-head">
              <div>
                <span
                  className="status-dot"
                  style={{ background: status.color }}
                />
                <h2>{status.name}</h2>
                <span className="column-count">{column.length}</span>
              </div>
            </div>
            <SortableContext
              items={column.map((t) => t.id)}
              strategy={rectSortingStrategy}
            >
              <div className="cards">
                {column.map(renderTask)}
                {!column.length && !filtered && (
                  <Empty className="column-empty">
                    <EmptyDescription>
                      {status.id === 'todo'
                        ? 'Место для следующего дела'
                        : status.id === 'doing'
                          ? 'Начни с одной задачи'
                          : status.id === 'waiting'
                            ? 'Ничего не ждёт ответа'
                            : 'Здесь будут маленькие победы'}
                    </EmptyDescription>
                  </Empty>
                )}
              </div>
            </SortableContext>
            {!archive && (
              <InlineCreate
                key={`${area}/${projectId}/${status.id}`}
                area={area}
                projectId={projectId}
                status={status.id}
                onSave={onCreate}
              />
            )}
          </Column>
        );
      })}
    </div>
  );
}
