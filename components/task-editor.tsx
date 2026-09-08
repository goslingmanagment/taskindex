'use client';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/use-workspace';
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
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import {
  AREAS,
  STATUSES,
  type Task,
  type Project,
  type AreaId,
  type Status,
} from '@/lib/workspace';
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
  projects,
  onClose,
  onSave,
  onArchive,
  onFirst,
}: {
  task: Task;
  projects: Project[];
  onClose: () => void;
  onSave: (t: Task) => Promise<Task>;
  onArchive: (t: Task) => Promise<void>;
  onFirst: (t: Task) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Task>(structuredClone(task));
  const [saved, setSaved] = useState(task);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [discard, setDiscard] = useState(false);
  const [more, setMore] = useState({
    note: !!task.note,
    due: !!task.due,
    list: task.checklist.length > 0,
  });
  const [conflict, setConflict] = useState<Task | null>(null);
  const [step, setStep] = useState('');
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(saved) || !!step.trim();
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
      const withStep = step.trim()
        ? {
            ...draft,
            checklist: [
              ...draft.checklist,
              { id: crypto.randomUUID(), text: step.trim(), done: false },
            ],
          }
        : draft;
      const next = await onSave({ ...withStep, title: withStep.title.trim() });
      setDraft(next);
      setSaved(next);
      setStep('');
      setDiscard(false);
      if (close) onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.current)
        setConflict(e.current as Task);
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
              {task.demo && <span className="example-tag">Пример</span>}
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
                        patch({ area: v as AreaId, projectId: '' })
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
                        patch({ projectId: v === 'none' ? '' : v })
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
                    type="date"
                    value={draft.followUp}
                    onChange={(e) => patch({ followUp: e.target.value })}
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
                    aria-label="Срок задачи"
                    type="date"
                    value={draft.due}
                    onChange={(e) => patch({ due: e.target.value })}
                  />
                  {draft.due && (
                    <Button variant="ghost" onClick={() => patch({ due: '' })}>
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
          </fieldset>
          <footer className="editor-footer">
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {conflict && (
              <div className="conflict-box">
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
            <div>
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
              Не сохранять
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
