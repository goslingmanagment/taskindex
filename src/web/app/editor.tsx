'use client';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../lib/use-workspace';
import { workspaceStore } from './store';
import { readDraft, writeDraft, clearDraft } from './drafts';
import { editorBaseRevision, isFutureBaseError } from './editor-base';
import { TaskDiscussion } from './activity';
import {
  Check,
  Plus,
  X,
  Clock3,
  CalendarDays,
  ListChecks,
  Archive,
  ArrowUp,
  FileText,
} from 'lucide-react';
import { Button } from '../ui/button';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '../ui/collapsible';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Checkbox } from '../ui/checkbox';
import { Progress } from '../ui/progress';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '../ui/sheet';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '../ui/select';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '../ui/alert-dialog';
import {
  AREAS,
  STATUSES,
  type Task,
  type Project,
  type AreaId,
  type Status,
} from '../lib/workspace';
export function Choice({
  value,
  onChange,
  items,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  items: { value: string; label: string }[];
  label: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v !== null) onChange(String(v));
      }}
      items={items}
    >
      <SelectTrigger id={label} className="field-select" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function TaskEditor({
  task,
  base,
  pendingLabel,
  projects,
  onClose,
  onSave,
  onArchive,
  onFirst,
}: {
  /** The task as displayed (optimistic previews included); identifies the card. */
  task: Task;
  /** TI-007: the confirmed record; every save, archive and move is based on it. */
  base: Task;
  /** Label of a command of this task that is still unconfirmed. */
  pendingLabel?: string;
  projects: Project[];
  onClose: () => void;
  onSave: (t: Task, base: Task, operationId: string) => Promise<Task>;
  onArchive: (t: Task) => Promise<void>;
  onFirst: (t: Task) => Promise<void>;
}) {
  const generation = workspaceStore.getSnapshot().generation;
  const [restored] = useState(() =>
    readDraft<{
      task: Partial<Task>;
      step: string;
      submission?: { task: Task; base: Task; signature: string };
    }>(task.id),
  );
  const foreign = restored && restored.generation !== generation;
  const [draft, setDraft] = useState<Task>(() => ({
    ...base,
    ...(!foreign ? restored?.fields.task : {}),
  }));
  const [saved, setSaved] = useState(() => ({
    ...base,
    revision: editorBaseRevision(
      !foreign && restored ? restored.baseRevision : undefined,
      base,
    ),
  }));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [discard, setDiscard] = useState(false);
  const [more, setMore] = useState({
    note: !!task.note,
    due: !!task.due,
    list: task.checklist.length > 0,
  });
  const [conflict, setConflict] = useState<Task | null>(null);
  const [step, setStep] = useState(!foreign ? restored?.fields.step || '' : '');
  const saveIntent = useRef<{
    id: string;
    task: Task;
    base: Task;
    signature: string;
  } | null>(
    !foreign && restored?.operationId && restored.fields.submission
      ? { id: restored.operationId, ...restored.fields.submission }
      : null,
  );
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(saved) || !!step.trim();
  useEffect(() => {
    if (dirty) {
      const fields = Object.fromEntries(
        Object.entries(draft).filter(
          ([key, value]) =>
            JSON.stringify(value) !== JSON.stringify(saved[key as keyof Task]),
        ),
      );
      writeDraft(task.id, {
        formatVersion: 1,
        generation,
        baseRevision: saved.revision,
        fields: {
          task: fields,
          step,
          ...(saveIntent.current ? { submission: saveIntent.current } : {}),
        },
        ...(saveIntent.current ? { operationId: saveIntent.current.id } : {}),
      });
    } else if (!foreign) clearDraft(task.id);
  }, [draft, saved, step, dirty, generation, task.id, foreign]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const patch = (part: Partial<Task>) => setDraft((d) => ({ ...d, ...part }));
  async function save(close = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const signature = JSON.stringify({ draft, step });
      if (saveIntent.current && saveIntent.current.signature !== signature) {
        const state = workspaceStore.getSnapshot();
        if (
          !state.pending.some(
            (p) => p.envelope.operationId === saveIntent.current?.id,
          )
        ) {
          saveIntent.current = null;
          setConflict(
            state.confirmed.tasks.find((t) => t.id === task.id) ?? null,
          );
          throw new Error(
            'Предыдущее сохранение завершилось. Совместите версии и проверьте новые правки.',
          );
        }
        throw new Error(
          'Предыдущее сохранение не подтверждено. Повторите его в панели состояния, затем проверьте версии.',
        );
      }
      const withStep = step.trim()
        ? {
            ...draft,
            checklist: [
              ...draft.checklist,
              { id: crypto.randomUUID(), text: step.trim(), done: false },
            ],
          }
        : draft;
      saveIntent.current ??= {
        id: crypto.randomUUID(),
        task: { ...withStep, title: withStep.title.trim() },
        base: saved,
        signature,
      };
      writeDraft(task.id, {
        formatVersion: 1,
        generation,
        baseRevision: saved.revision,
        operationId: saveIntent.current.id,
        fields: { task: draft, step, submission: saveIntent.current },
      });
      const next = await onSave(
        saveIntent.current.task,
        saveIntent.current.base,
        saveIntent.current.id,
      );
      saveIntent.current = null;
      clearDraft(task.id);
      setDraft(next);
      setSaved(next);
      setStep('');
      setDiscard(false);
      if (close) onClose();
    } catch (e) {
      if (e instanceof ApiError && !e.detail.retryable)
        saveIntent.current = null;
      if (e instanceof ApiError && e.status === 409 && e.current)
        setConflict(e.current as Task);
      if (
        e instanceof ApiError &&
        e.detail.code === 'invalid' &&
        isFutureBaseError(e.detail.message)
      ) {
        // The base got ahead of the server: fall back to the confirmed revision
        // (the draft effect rewrites baseRevision) and let the owner save again.
        setSaved((s) => ({ ...s, revision: base.revision }));
        setError(
          'Версия карточки не совпала с сервером. Проверьте текст и сохраните ещё раз.',
        );
        return;
      }
      setError(e instanceof Error ? e.message : 'Не сохранилось.');
    } finally {
      setBusy(false);
    }
  }
  function close() {
    if (busy) return;
    if (dirty) setDiscard(true);
    else onClose();
  }
  async function archive() {
    if (busy) return;
    setBusy(true);
    try {
      await onArchive(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось убрать задачу.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Sheet
        open
        onOpenChange={(v) => {
          if (!v) close();
        }}
      >
        <SheetContent
          showCloseButton={false}
          className="task-sheet"
          finalFocus={() => {
            const target = document.querySelector<HTMLElement>(
              `[data-task-open="${task.id}"]`,
            );
            return (
              target || document.querySelector<HTMLElement>('.primary-add')
            );
          }}
        >
          <SheetHeader className="editor-header">
            <div>
              <span className="editor-eyebrow">ЗАДАЧА</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={close}
              aria-label="Закрыть карточку"
              disabled={busy}
            >
              <X />
            </Button>
            <SheetTitle className="sr-only">Редактирование задачи</SheetTitle>
            <SheetDescription className="sr-only">
              Задача, состояние, заметки и шаги
            </SheetDescription>
          </SheetHeader>
          <fieldset disabled={busy} className="editor-body">
            {pendingLabel && (
              <output className="pending-notice editor-pending">
                Ожидает подтверждения: {pendingLabel.toLowerCase()}
              </output>
            )}
            {foreign && (
              <details className="conflict-box">
                <summary>Черновик от прежней версии базы</summary>
                <p>Перенесите нужный текст вручную.</p>
                <pre>{JSON.stringify(restored.fields, null, 2)}</pre>
              </details>
            )}
            <textarea
              ref={titleRef}
              aria-label="Название задачи"
              maxLength={240}
              className="editor-title"
              rows={2}
              value={draft.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="Что нужно сделать?"
            />
            <div className="editor-state">
              <label htmlFor="Состояние задачи">
                Состояние
                <Choice
                  value={draft.status}
                  label="Состояние задачи"
                  items={STATUSES.map((s) => ({ value: s.id, label: s.name }))}
                  onChange={(v) => patch({ status: v as Status })}
                />
              </label>
            </div>
            <Collapsible>
              <div className="editor-location">
                <span>
                  {AREAS.find((a) => a.id === draft.area)?.name} /{' '}
                  {projects.find((p) => p.id === draft.projectId)?.name ||
                    'Без направления'}
                </span>
                <CollapsibleTrigger render={<Button variant="ghost" />}>
                  Переместить
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent>
                <div className="editor-fields editor-move">
                  <label htmlFor="Область задачи">
                    Область
                    <Choice
                      value={draft.area}
                      label="Область задачи"
                      items={AREAS.map((a) => ({ value: a.id, label: a.name }))}
                      onChange={(v) =>
                        patch({ area: v as AreaId, projectId: null })
                      }
                    />
                  </label>
                  <label className="full-field" htmlFor="Проект задачи">
                    {draft.area === 'development' ? 'Проект' : 'Направление'}
                    <Choice
                      value={draft.projectId || 'none'}
                      label="Проект задачи"
                      items={[
                        { value: 'none', label: 'Без направления' },
                        ...projects
                          .filter((p) => p.area === draft.area)
                          .map((p) => ({ value: p.id, label: p.name })),
                      ]}
                      onChange={(v) =>
                        patch({ projectId: v === 'none' ? null : v })
                      }
                    />
                  </label>
                </div>
              </CollapsibleContent>
            </Collapsible>
            {draft.status === 'waiting' && (
              <section className="waiting-editor">
                <h3>
                  <Clock3 size={17} />
                  Чего ждём?
                </h3>
                <Input
                  aria-label="От кого или чего ждём"
                  placeholder="Например, ответ дизайнера"
                  maxLength={240}
                  value={draft.waitingFor}
                  onChange={(e) => patch({ waitingFor: e.target.value })}
                />
                <label>
                  Когда вернуться к задаче
                  <input
                    className="date-field"
                    type="date"
                    value={draft.followUp || ''}
                    onChange={(e) =>
                      patch({ followUp: e.target.value || null })
                    }
                  />
                </label>
                <p>Это дата проверки, а не дедлайн.</p>
              </section>
            )}
            <div className="add-details">
              {!more.note && (
                <Button
                  variant="outline"
                  onClick={() => setMore((m) => ({ ...m, note: true }))}
                >
                  <FileText />
                  Заметка
                </Button>
              )}
              {!more.due && (
                <Button
                  variant="outline"
                  onClick={() => setMore((m) => ({ ...m, due: true }))}
                >
                  <CalendarDays />
                  Срок
                </Button>
              )}
              {!more.list && (
                <Button
                  variant="outline"
                  onClick={() => setMore((m) => ({ ...m, list: true }))}
                >
                  <ListChecks />
                  Шаги
                </Button>
              )}
            </div>
            {more.note && (
              <section className="detail-section">
                <h3>
                  <FileText size={17} />
                  Заметка
                </h3>
                <Textarea
                  aria-label="Заметка к задаче"
                  placeholder="Контекст, ссылки или мысли…"
                  maxLength={16000}
                  value={draft.note}
                  onChange={(e) => patch({ note: e.target.value })}
                  className="note-input"
                />
              </section>
            )}
            {more.due && (
              <section className="detail-section">
                <h3>
                  <CalendarDays size={17} />
                  Срок
                </h3>
                <div className="date-row">
                  <input
                    className="date-field"
                    aria-label="Срок задачи"
                    type="date"
                    value={draft.due || ''}
                    onChange={(e) => patch({ due: e.target.value || null })}
                  />
                  {draft.due && (
                    <Button
                      variant="ghost"
                      onClick={() => patch({ due: null })}
                    >
                      Убрать срок
                    </Button>
                  )}
                </div>
              </section>
            )}
            {more.list && (
              <section className="detail-section">
                <h3>
                  <ListChecks size={18} />
                  Шаги
                  <span>
                    {draft.checklist.filter((c) => c.done).length} /{' '}
                    {draft.checklist.length}
                  </span>
                </h3>
                {draft.checklist.length > 0 && (
                  <Progress
                    className="checklist-progress"
                    aria-label="Выполненные шаги"
                    value={
                      (draft.checklist.filter((c) => c.done).length /
                        draft.checklist.length) *
                      100
                    }
                  />
                )}
                {draft.checklist.map((c) => (
                  <div className="checklist-row" key={c.id}>
                    <Checkbox
                      checked={c.done}
                      onCheckedChange={(v) =>
                        patch({
                          checklist: draft.checklist.map((i) =>
                            i.id === c.id ? { ...i, done: v } : i,
                          ),
                        })
                      }
                      aria-label={'Выполнено: ' + c.text}
                    />
                    <Input
                      aria-label="Название шага"
                      maxLength={500}
                      value={c.text}
                      className={c.done ? 'step-done' : ''}
                      onChange={(e) =>
                        patch({
                          checklist: draft.checklist.map((i) =>
                            i.id === c.id ? { ...i, text: e.target.value } : i,
                          ),
                        })
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={'Убрать шаг ' + c.text}
                      onClick={() =>
                        patch({
                          checklist: draft.checklist.filter(
                            (i) => i.id !== c.id,
                          ),
                        })
                      }
                    >
                      <X size={14} />
                    </Button>
                  </div>
                ))}
                <form
                  className="new-step"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (step.trim()) {
                      patch({
                        checklist: [
                          ...draft.checklist,
                          {
                            id: crypto.randomUUID(),
                            text: step.trim(),
                            done: false,
                          },
                        ],
                      });
                      setStep('');
                    }
                  }}
                >
                  <Input
                    placeholder="Добавить шаг…"
                    aria-label="Новый шаг"
                    value={step}
                    maxLength={500}
                    onChange={(e) => setStep(e.target.value)}
                  />
                  <Button
                    type="submit"
                    variant="ghost"
                    aria-label="Добавить шаг"
                    disabled={!step.trim() || draft.checklist.length >= 100}
                  >
                    <Plus />
                  </Button>
                </form>
              </section>
            )}
            <div className="secondary-actions">
              <Button
                variant="ghost"
                disabled={busy || dirty}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onFirst(saved);
                    onClose();
                  } catch (e) {
                    setError(
                      e instanceof Error
                        ? e.message
                        : 'Не удалось переместить задачу.',
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <ArrowUp />В начало очереди
              </Button>
              <Button
                variant="ghost"
                disabled={busy || dirty}
                onClick={archive}
              >
                <Archive />
                {saved.archived ? 'Вернуть из архива' : 'В архив'}
              </Button>
            </div>
            <TaskDiscussion task={task} />
          </fieldset>
          <footer className="editor-footer">
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {conflict && (
              <div className="conflict-box editor-conflict">
                <details>
                  <summary>Актуальная версия</summary>
                  <pre>{JSON.stringify(conflict, null, 2)}</pre>
                </details>
                <p>
                  Совместим версии: оставим изменённые тобой поля, остальные
                  возьмём из последней версии.
                </p>
                <Button
                  variant="outline"
                  onClick={() => {
                    const changes = Object.fromEntries(
                      Object.entries(draft).filter(
                        ([key, value]) =>
                          key !== 'revision' &&
                          JSON.stringify(value) !==
                            JSON.stringify(saved[key as keyof Task]),
                      ),
                    );
                    setDraft({
                      ...conflict,
                      ...changes,
                      revision: conflict.revision,
                    });
                    setSaved(conflict);
                    setConflict(null);
                    setError('');
                  }}
                >
                  Совместить и проверить
                </Button>
              </div>
            )}
            <div className="editor-actions">
              <span className="save-hint">
                {busy
                  ? 'Сохраняем…'
                  : dirty
                    ? 'Есть изменения'
                    : 'Всё сохранено'}
              </span>
              <Button variant="outline" disabled={busy} onClick={close}>
                Закрыть
              </Button>
              <Button
                disabled={busy || !draft.title.trim() || !dirty}
                onClick={() => void save(true)}
              >
                <Check />
                Сохранить
              </Button>
            </div>
          </footer>
        </SheetContent>
      </Sheet>
      <AlertDialog open={discard} onOpenChange={setDiscard}>
        <AlertDialogContent>
          <AlertDialogTitle>Сохранить изменения?</AlertDialogTitle>
          <AlertDialogDescription>
            В карточке остались несохранённые правки.
          </AlertDialogDescription>
          {error && <p className="form-error">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Продолжить</AlertDialogCancel>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDiscard(false);
                onClose();
              }}
            >
              Закрыть с черновиком
            </Button>
            <Button
              disabled={busy || !draft.title.trim()}
              onClick={() => void save(true)}
            >
              Сохранить
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
