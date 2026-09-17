// oxlint-disable jsx-a11y/prefer-tag-over-role -- план 07, §3.9: `<output>` это
// результат вычисления и по HTML принимает только фразовое содержимое, а здесь
// внутри живут абзацы, `pre` и кнопки. Роль `status` даёт ту же живую область
// без нарушения модели содержимого.
import { useEffect, useRef, useState } from 'react';
import { LIMITS } from '@shared/limits';
import { PRIORITIES, type Priority } from '@shared/labels';
import type { Label } from '@shared/model';
import {
  AREAS,
  type AreaId,
  type Project,
  type Status,
  type Task,
} from '@shared/model';
import {
  Archive,
  ArrowUp,
  CalendarDays,
  Check,
  FileText,
  ListChecks,
  Link2,
  Tag,
  X,
} from 'lucide-react';
import { Button } from '../../ui/button';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '../../ui/collapsible';
import { Textarea } from '../../ui/textarea';
import { Input } from '../../ui/input';
import { Checkbox } from '../../ui/checkbox';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '../../ui/sheet';
import { TaskDiscussion } from '../activity';
import { ConflictPanel } from '../conflict-panel';
import { Choice } from './choice';
import { ChecklistEditor } from './checklist-editor';
import { DiscardDialog } from './discard-dialog';
import { TASK_STATES as STATUSES, visibleStatus } from '../board-columns';
import { useTaskDraft } from './use-task-draft';
import { useSaveIntent } from './use-save-intent';
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
  const [discard, setDiscard] = useState(false);
  const [sections, setSections] = useState({
    note: !!task.note,
    due: !!task.due,
    list: task.checklist.length > 0,
    labels: draft.labels.length > 0,
    closes: !!draft.closes,
  });
  const titleRef = useRef<HTMLTextAreaElement>(null);
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
  const details = [
    { key: 'note' as const, icon: <FileText />, label: 'Заметка' },
    { key: 'due' as const, icon: <CalendarDays />, label: 'Срок' },
    { key: 'list' as const, icon: <ListChecks />, label: 'Шаги' },
    { key: 'labels' as const, icon: <Tag />, label: 'Метки' },
    { key: 'closes' as const, icon: <Link2 />, label: 'Закрывает проблему' },
  ];
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
            <div>
              <span className="editor-eyebrow">ЗАДАЧА</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={close}
              aria-label="Закрыть карточку"
              disabled={intent.busy}
            >
              <X />
            </Button>
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
              rows={2}
              value={draft.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="Что нужно сделать?"
            />
            <div className="editor-state">
              <label htmlFor="task-status">
                Состояние
                <Choice
                  id="task-status"
                  value={visibleStatus(draft.status)}
                  label="Состояние задачи"
                  items={STATUSES.map((s) => ({ value: s.id, label: s.name }))}
                  onChange={(v) => patch({ status: v as Status })}
                />
              </label>
              <label htmlFor="task-priority">
                Приоритет
                <Choice
                  id="task-priority"
                  value={draft.priority}
                  label="Приоритет задачи"
                  items={PRIORITIES.map((priority) => ({
                    value: priority.id,
                    label: `${priority.name} · ${priority.hint}`,
                  }))}
                  onChange={(value) => patch({ priority: value as Priority })}
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
                  <label htmlFor="task-area">
                    Область
                    <Choice
                      id="task-area"
                      value={draft.area}
                      label="Область задачи"
                      items={AREAS.map((a) => ({ value: a.id, label: a.name }))}
                      onChange={(v) =>
                        patch({ area: v as AreaId, projectId: null })
                      }
                    />
                  </label>
                  <label className="full-field" htmlFor="task-project">
                    {draft.area === 'development' ? 'Проект' : 'Направление'}
                    <Choice
                      id="task-project"
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
            <div className="add-details">
              {details
                .filter(({ key }) => !sections[key])
                .map(({ key, icon, label }) => (
                  <Button
                    key={key}
                    variant="outline"
                    onClick={() => setSections((s) => ({ ...s, [key]: true }))}
                  >
                    {icon}
                    {label}
                  </Button>
                ))}
            </div>
            {sections.note && (
              <section className="detail-section">
                <h3>
                  <FileText size={17} />
                  Заметка
                </h3>
                <Textarea
                  aria-label="Заметка к задаче"
                  placeholder="Контекст, ссылки или мысли…"
                  maxLength={LIMITS.taskNote}
                  value={draft.note}
                  onChange={(e) => patch({ note: e.target.value })}
                  className="note-input"
                />
              </section>
            )}
            {sections.due && (
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
            {sections.list && (
              <ChecklistEditor
                draft={draft}
                patch={patch}
                step={form.step}
                setStep={form.setStep}
              />
            )}
            {sections.labels && (
              <section className="detail-section">
                <h3>
                  <Tag size={17} />
                  Метки
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="section-action"
                    onClick={onManageLabels}
                  >
                    Настроить
                  </Button>
                </h3>
                <div className="label-picker">
                  {catalogue.map((label) => (
                    <label
                      key={label.id}
                      htmlFor={`label-${label.id}`}
                      className="label-option"
                    >
                      <Checkbox
                        id={`label-${label.id}`}
                        aria-labelledby={`label-name-${label.id}`}
                        aria-describedby={`label-description-${label.id}`}
                        checked={draft.labels.includes(label.id)}
                        onCheckedChange={(checked) =>
                          patch({
                            labels: catalogue
                              .filter((item) =>
                                item.id === label.id
                                  ? checked
                                  : draft.labels.includes(item.id),
                              )
                              .map((item) => item.id),
                          })
                        }
                      />
                      <span
                        className="tag-dot"
                        style={{ background: label.color }}
                      />
                      <span id={`label-name-${label.id}`}>
                        <span className="sr-only">Метка: </span>
                        {label.name}
                      </span>
                      <small id={`label-description-${label.id}`}>
                        {label.description}
                      </small>
                    </label>
                  ))}
                </div>
              </section>
            )}
            {sections.closes && (
              <section className="detail-section">
                <h3>
                  <Link2 size={17} />
                  Закрывает проблему
                </h3>
                <Input
                  aria-label="Слаг проблемы"
                  placeholder="Слаг из списка проблем"
                  maxLength={LIMITS.closes}
                  value={draft.closes ?? ''}
                  onChange={(event) =>
                    patch({
                      closes: event.target.value.trim().toLowerCase() || null,
                    })
                  }
                />
                <p className="field-hint">
                  Слаг из /OS/PROBLEMS.md: строчные латинские буквы, цифры и
                  дефис.
                </p>
              </section>
            )}
            <div className="secondary-actions">
              <Button
                variant="ghost"
                disabled={intent.busy || dirty}
                onClick={() => void intent.moveToQueueTop()}
              >
                <ArrowUp />В начало очереди
              </Button>
              <Button
                variant="ghost"
                disabled={intent.busy || dirty}
                onClick={() => void intent.archive()}
              >
                <Archive />
                {form.base.archived ? 'Вернуть из архива' : 'В архив'}
              </Button>
            </div>
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
