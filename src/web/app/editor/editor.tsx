// oxlint-disable jsx-a11y/prefer-tag-over-role -- план 07, §3.9: `<output>` это
// результат вычисления и по HTML принимает только фразовое содержимое, а здесь
// внутри живут абзацы, `pre` и кнопки. Роль `status` даёт ту же живую область
// без нарушения модели содержимого.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LIMITS } from '@shared/limits';
import { PRIORITIES } from '@shared/labels';
import type { Label } from '@shared/model';
import {
  AREAS,
  type ChecklistItem,
  type Project,
  type Task,
} from '@shared/model';
import { dateLabel } from '@shared/queries';
import {
  Archive,
  ArrowUp,
  CalendarDays,
  Check,
  ChevronDown,
  Ellipsis,
  Link2,
  Plus,
  X,
} from 'lucide-react';
import { Button } from '../../ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { Textarea } from '../../ui/textarea';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '../../ui/sheet';
import { TaskDiscussion } from '../activity';
import { ConflictPanel } from '../conflict-panel';
import { ChecklistEditor } from './checklist-editor';
import { DiscardDialog } from './discard-dialog';
import { TASK_STATES as STATUSES, visibleStatus } from '../board-columns';
import { useTaskDraft } from './use-task-draft';
import { useSaveIntent } from './use-save-intent';
import { checklistPromoteCommand } from '../commands';
import { workspaceStore } from '../store';
import { useWorkspaceCommands } from '../use-workspace-commands';
import { useWorkspace } from '../use-workspace';
import { toast } from '../../ui/toast';
// The title and the note hug their text. `field-sizing: content` does it in
// CSS; an engine without it takes the height from scrollHeight.
function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || CSS.supports('field-sizing', 'content')) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);
  return ref;
}
// TI-059 (план 07, шаг 13): сборка карточки. Состояние формы — в `use-task-draft`,
// отправка и её исходы — в `use-save-intent`, разделы — отдельными компонентами.
export function TaskEditor({
  task,
  base,
  pendingLabel,
  projects,
  labels,
  onManageLabels,
  onClose,
}: {
  /** The task as displayed (optimistic previews included); identifies the card. */
  task: Task;
  /** TI-007: the confirmed record; every save, archive and move is based on it. */
  base: Task;
  /** Label of a command of this task that is still unconfirmed. */
  pendingLabel?: string;
  projects: Project[];
  /** The label catalogue; the picker lists the active labels. */
  labels: Label[];
  onManageLabels: () => void;
  onClose: () => void;
}) {
  const catalogue = labels.filter((label) => !label.archivedAt);
  const form = useTaskDraft(task, base);
  const intent = useSaveIntent(form, task, base, onClose);
  const { draft, patch, dirty } = form;
  const commands = useWorkspaceCommands();
  // TI-095: a promotion is its own operation on the saved card; the form
  // then takes the confirmed record with the new link.
  const promote = (item: ChecklistItem) =>
    void commands
      .execute(
        checklistPromoteCommand(base, item.id),
        `Шаг вынесен в задачу «${item.text}»`,
      )
      .then(() => {
        const current = workspaceStore
          .getSnapshot()
          .confirmed.tasks.find((t) => t.id === task.id);
        if (current) form.merge(current);
      })
      .catch((error: Error) =>
        toast.add({ title: error.message, type: 'error' }),
      );
  const [discard, setDiscard] = useState(false);
  // The due date and the problem slug show up as chips once asked for; the
  // note, the steps and the labels are always in place.
  const [sections, setSections] = useState({
    due: !!task.due,
    closes: !!draft.closes,
  });
  const { today } = useWorkspace();
  const titleRef = useAutoGrow(draft.title);
  const noteRef = useAutoGrow(draft.note);
  const dueRef = useRef<HTMLInputElement>(null);
  const closesRef = useRef<HTMLInputElement>(null);
  const status = STATUSES.find((s) => s.id === visibleStatus(draft.status))!;
  const priority = PRIORITIES.find((p) => p.id === draft.priority)!;
  const location = `${AREAS.find((a) => a.id === draft.area)?.name} / ${
    projects.find((p) => p.id === draft.projectId)?.name || 'Без направления'
  }`;
  const setLabel = (id: string, checked: boolean) =>
    patch({
      labels: catalogue
        .filter((item) =>
          item.id === id ? checked : draft.labels.includes(item.id),
        )
        .map((item) => item.id),
    });
  const openPicker = (input: HTMLInputElement | null) => {
    try {
      input?.showPicker();
    } catch {
      // No picker API or no user activation: the field still takes typing.
    }
  };
  // A chip added by the owner takes the focus once it is in the DOM; chips of
  // an already filled card do not.
  const added = useRef<'due' | 'closes' | null>(null);
  useEffect(() => {
    if (added.current === 'due') {
      dueRef.current?.focus();
      openPicker(dueRef.current);
    }
    if (added.current === 'closes') closesRef.current?.focus();
    added.current = null;
  }, [sections]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function close() {
    if (intent.busy) return;
    if (dirty) setDiscard(true);
    else onClose();
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
          finalFocus={() =>
            document.querySelector<HTMLElement>(
              `[data-task-open="${task.id}"]`,
            ) || document.querySelector<HTMLElement>('.primary-add')
          }
        >
          <SheetHeader className="editor-header">
            <DropdownMenu>
              <DropdownMenuTrigger
                className="editor-crumb"
                title="Переместить"
                disabled={intent.busy}
              >
                <span>{location}</span>
                <ChevronDown size={14} />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="editor-menu">
                <DropdownMenuRadioGroup
                  value={`${draft.area}:${draft.projectId ?? 'none'}`}
                >
                  {AREAS.map((area) => (
                    <DropdownMenuGroup key={area.id}>
                      <DropdownMenuLabel>{area.name}</DropdownMenuLabel>
                      {[
                        ...projects.filter((p) => p.area === area.id),
                        null,
                      ].map((project) => (
                        <DropdownMenuRadioItem
                          key={project?.id ?? 'none'}
                          value={`${area.id}:${project?.id ?? 'none'}`}
                          closeOnClick
                          onClick={() =>
                            patch({
                              area: area.id,
                              projectId: project?.id ?? null,
                            })
                          }
                        >
                          {project?.name ?? 'Без направления'}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuGroup>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <div>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Действия с задачей"
                      disabled={intent.busy}
                    />
                  }
                >
                  <Ellipsis />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="editor-menu">
                  <DropdownMenuItem
                    disabled={dirty}
                    onClick={() => void intent.moveToQueueTop()}
                  >
                    <span className="menu-lead">
                      <ArrowUp />
                    </span>
                    В начало очереди
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={dirty}
                    onClick={() => void intent.archive()}
                  >
                    <span className="menu-lead">
                      <Archive />
                    </span>
                    {form.base.archived ? 'Вернуть из архива' : 'В архив'}
                  </DropdownMenuItem>
                  {dirty && (
                    <p className="menu-note">Сначала сохраните изменения</p>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="icon"
                onClick={close}
                aria-label="Закрыть карточку"
                disabled={intent.busy}
              >
                <X />
              </Button>
            </div>
            <SheetTitle className="sr-only">Редактирование задачи</SheetTitle>
            <SheetDescription className="sr-only">
              Задача, состояние, заметки и шаги
            </SheetDescription>
          </SheetHeader>
          <fieldset disabled={intent.busy} className="editor-body">
            {pendingLabel && (
              <p className="pending-notice editor-pending" role="status">
                Ожидает подтверждения: {pendingLabel.toLowerCase()}
              </p>
            )}
            {form.fromOtherGeneration && form.restored && (
              <details className="conflict-box">
                <summary>Черновик от прежней версии базы</summary>
                <p>Перенесите нужный текст вручную.</p>
                <pre>{JSON.stringify(form.restored.fields, null, 2)}</pre>
              </details>
            )}
            <textarea
              ref={titleRef}
              aria-label="Название задачи"
              maxLength={LIMITS.taskTitle}
              className="editor-title"
              rows={1}
              value={draft.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="Что нужно сделать?"
            />
            <div className="editor-meta">
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="meta-chip"
                  aria-label={`Состояние задачи: ${status.name}`}
                >
                  <span
                    className="status-dot"
                    style={{ background: status.color }}
                  />
                  {status.name}
                  <ChevronDown size={13} />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="editor-menu">
                  <DropdownMenuRadioGroup value={status.id}>
                    {STATUSES.map((item) => (
                      <DropdownMenuRadioItem
                        key={item.id}
                        value={item.id}
                        closeOnClick
                        onClick={() => {
                          // A legacy waiting task shows as the queue; picking
                          // the shown value must not rewrite it.
                          if (item.id !== status.id) patch({ status: item.id });
                        }}
                      >
                        <span className="menu-lead">
                          <span
                            className="status-dot"
                            style={{ background: item.color }}
                          />
                        </span>
                        {item.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="meta-chip"
                  aria-label={`Приоритет задачи: ${priority.name}`}
                  title={priority.hint}
                >
                  <span className={`priority-mark priority-${priority.id}`}>
                    {priority.name}
                  </span>
                  <ChevronDown size={13} />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="editor-menu">
                  <DropdownMenuRadioGroup value={priority.id}>
                    {PRIORITIES.map((level) => (
                      <DropdownMenuRadioItem
                        key={level.id}
                        value={level.id}
                        closeOnClick
                        onClick={() => patch({ priority: level.id })}
                      >
                        <span className="menu-lead">
                          <span
                            className={`priority-mark priority-${level.id}`}
                          >
                            {level.name}
                          </span>
                        </span>
                        {level.hint}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              {labels
                .filter((label) => draft.labels.includes(label.id))
                .map((label) => (
                  <button
                    type="button"
                    key={label.id}
                    className="meta-chip"
                    aria-label={'Снять метку ' + label.name}
                    onClick={() => setLabel(label.id, false)}
                  >
                    <span
                      className="tag-dot"
                      style={{ background: label.color }}
                    />
                    {label.name}
                    <X size={12} />
                  </button>
                ))}
              {sections.due && (
                <span
                  className={
                    'meta-chip due-chip' +
                    (draft.due && draft.due < today && draft.status !== 'done'
                      ? ' overdue'
                      : '')
                  }
                >
                  <CalendarDays size={14} />
                  <span aria-hidden="true">
                    {draft.due ? dateLabel(draft.due, today) : 'Выбрать дату'}
                  </span>
                  <input
                    ref={dueRef}
                    className="due-input"
                    aria-label="Срок задачи"
                    type="date"
                    value={draft.due || ''}
                    onChange={(e) => patch({ due: e.target.value || null })}
                    onClick={(e) => openPicker(e.currentTarget)}
                  />
                  <button
                    type="button"
                    className="chip-remove"
                    aria-label="Убрать срок"
                    onClick={() => {
                      patch({ due: null });
                      setSections((s) => ({ ...s, due: false }));
                    }}
                  >
                    <X size={12} />
                  </button>
                </span>
              )}
              {sections.closes && (
                <span className="meta-chip closes-chip">
                  <Link2 size={14} />
                  <input
                    ref={closesRef}
                    className="closes-input"
                    aria-label="Слаг проблемы"
                    aria-describedby="closes-hint"
                    placeholder="слаг-проблемы"
                    maxLength={LIMITS.closes}
                    size={Math.max(13, (draft.closes ?? '').length + 1)}
                    value={draft.closes ?? ''}
                    onChange={(event) =>
                      patch({
                        closes: event.target.value.trim().toLowerCase() || null,
                      })
                    }
                  />
                  <button
                    type="button"
                    className="chip-remove"
                    aria-label="Убрать проблему"
                    onClick={() => {
                      patch({ closes: null });
                      setSections((s) => ({ ...s, closes: false }));
                    }}
                  >
                    <X size={12} />
                  </button>
                </span>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger className="meta-chip meta-chip-add">
                  <Plus size={13} />
                  Метка
                </DropdownMenuTrigger>
                <DropdownMenuContent className="editor-menu label-menu">
                  {catalogue.map((label) => (
                    <DropdownMenuCheckboxItem
                      key={label.id}
                      className="label-choice"
                      aria-label={'Метка: ' + label.name}
                      aria-describedby={`label-description-${label.id}`}
                      checked={draft.labels.includes(label.id)}
                      onCheckedChange={(checked) => setLabel(label.id, checked)}
                    >
                      <span className="menu-lead">
                        <span
                          className="tag-dot"
                          style={{ background: label.color }}
                        />
                      </span>
                      <span className="label-choice-text">
                        {label.name}
                        <small id={`label-description-${label.id}`}>
                          {label.description}
                        </small>
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                  {catalogue.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem onClick={onManageLabels}>
                    Настроить метки…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {!sections.due && (
                <button
                  type="button"
                  className="meta-chip meta-chip-add"
                  onClick={() => {
                    added.current = 'due';
                    setSections((s) => ({ ...s, due: true }));
                  }}
                >
                  <Plus size={13} />
                  Срок
                </button>
              )}
              {!sections.closes && (
                <button
                  type="button"
                  className="meta-chip meta-chip-add"
                  onClick={() => {
                    added.current = 'closes';
                    setSections((s) => ({ ...s, closes: true }));
                  }}
                >
                  <Plus size={13} />
                  Проблема
                </button>
              )}
            </div>
            {sections.closes && !draft.closes && (
              <p className="field-hint" id="closes-hint">
                Проблема, которую закрывает задача: слаг из /OS/PROBLEMS.md,
                строчные латинские буквы, цифры и дефис.
              </p>
            )}
            <Textarea
              ref={noteRef}
              aria-label="Заметка к задаче"
              placeholder="Заметка: контекст, ссылки, мысли…"
              maxLength={LIMITS.taskNote}
              value={draft.note}
              onChange={(e) => patch({ note: e.target.value })}
              className="note-input"
            />
            <ChecklistEditor
              draft={draft}
              patch={patch}
              step={form.step}
              setStep={form.setStep}
              onPromote={dirty ? undefined : promote}
            />
            <TaskDiscussion task={task} />
          </fieldset>
          <footer className="editor-footer">
            {intent.error && (
              <p className="form-error" role="alert">
                {intent.error}
              </p>
            )}
            {intent.conflict && (
              <ConflictPanel
                className="editor-conflict"
                summary={
                  <details>
                    <summary>Актуальная версия</summary>
                    <pre>{JSON.stringify(intent.conflict, null, 2)}</pre>
                  </details>
                }
                note="Совместим версии: оставим изменённые тобой поля, остальные возьмём из последней версии."
                onMerge={() => intent.merge()}
              />
            )}
            <div className="editor-actions">
              <span className="save-hint">
                {intent.busy
                  ? 'Сохраняем…'
                  : dirty
                    ? 'Есть изменения'
                    : 'Всё сохранено'}
              </span>
              <Button variant="outline" disabled={intent.busy} onClick={close}>
                Закрыть
              </Button>
              <Button
                disabled={intent.busy || !draft.title.trim() || !dirty}
                onClick={() => void intent.save(true)}
              >
                <Check />
                Сохранить
              </Button>
            </div>
          </footer>
        </SheetContent>
      </Sheet>
      <DiscardDialog
        open={discard}
        onOpenChange={setDiscard}
        busy={intent.busy}
        error={intent.error}
        canSave={draft.title.trim().length > 0}
        onSave={() => void intent.save(true)}
        onClose={() => {
          setDiscard(false);
          onClose();
        }}
      />
    </>
  );
}
