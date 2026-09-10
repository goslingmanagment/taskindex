import { type ReactNode, useEffect, useRef, useState } from 'react';
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
import {
  STATUSES,
  makeTask,
  type Task,
  type Status,
  type AreaId,
} from '../lib/workspace';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Empty, EmptyDescription } from '../ui/empty';
import { readDraft, writeDraft, clearDraft, subscribeDraft } from './drafts';
import { workspaceStore } from './store';
import { toast } from '../ui/toast';
import { ApiError } from './api';
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
    void move(task, status, after ? undefined : target, after).catch((e) =>
      toast.add({ title: e.message, type: 'error' }),
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
function InlineCreate({
  area,
  projectId,
  status,
  onSave,
}: {
  area: AreaId;
  projectId: string;
  status: Status;
  onSave: (task: Task, operationId: string) => Promise<Task>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const key = `new/${area}/${projectId}/${status}`,
    generation = workspaceStore.getSnapshot().generation;
  const [title, setTitle] = useState(() => {
    const draft = readDraft<{ title: string }>(key);
    return draft?.generation === generation ? draft.fields.title : '';
  });
  const [foreign, setForeign] = useState(() => {
    const draft = readDraft<{ title: string }>(key);
    return draft && draft.generation !== generation ? draft.fields.title : null;
  });
  const intent = useRef<{ id: string; operationId: string } | null>(null);
  useEffect(
    () =>
      subscribeDraft(key, () => {
        const draft = readDraft<{ title: string }>(key);
        const valid = draft?.generation === generation;
        setTitle(valid ? draft.fields.title : '');
        setForeign(draft && !valid ? draft.fields.title : null);
        intent.current =
          valid && draft.id && draft.operationId
            ? { id: draft.id, operationId: draft.operationId }
            : null;
      }),
    [key, generation],
  );
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      if (!intent.current) {
        const draft = readDraft<{ title: string }>(key);
        intent.current = {
          id:
            draft?.generation === generation && draft.id
              ? draft.id
              : crypto.randomUUID(),
          operationId:
            draft?.generation === generation && draft.operationId
              ? draft.operationId
              : crypto.randomUUID(),
        };
      }
      writeDraft(key, {
        formatVersion: 1,
        generation,
        baseRevision: 0,
        fields: { title },
        ...intent.current,
      });
      await onSave(
        makeTask({
          id: intent.current.id,
          area,
          projectId:
            projectId === 'all' || projectId === 'none' ? null : projectId,
          status,
          title: title.trim(),
        }),
        intent.current.operationId,
      );
      clearDraft(key);
      intent.current = null;
      setTitle('');
    } catch (e) {
      if (e instanceof ApiError && !e.detail.retryable) intent.current = null;
      setError(e instanceof Error ? e.message : 'Не удалось сохранить.');
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
        maxLength={240}
        value={title}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) setOpen(false);
        }}
        onChange={(e) => {
          setTitle(e.target.value);
          writeDraft(key, {
            formatVersion: 1,
            generation,
            baseRevision: 0,
            fields: { title: e.target.value },
            ...intent.current,
          });
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
  archive,
  filtered,
  disabled,
  renderTask,
  onCreate,
}: {
  tasks: Task[];
  view: 'board' | 'list';
  area: AreaId;
  projectId: string;
  archive: boolean;
  filtered: boolean;
  disabled: boolean;
  renderTask: (task: Task) => ReactNode;
  onCreate: (task: Task, operationId: string) => Promise<Task>;
}) {
  return (
    <div className={'kanban ' + (view === 'list' ? 'list-view' : '')}>
      {STATUSES.map((status) => {
        const column = tasks.filter((t) => t.status === status.id);
        return (
          <Column key={status.id} status={status.id} disabled={disabled}>
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
