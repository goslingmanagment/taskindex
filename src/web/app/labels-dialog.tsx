import { useState } from 'react';
import { Archive, ArchiveRestore, Pencil, Plus, Undo2 } from 'lucide-react';
import { LIMITS } from '@shared/limits';
import type { Label, Task } from '@shared/model';
import { uniqueSlug } from '@shared/slug';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { taskCount } from './labels';
import { useWorkspaceCommands } from './use-workspace-commands';
// The owner's label catalogue (0007). Everything here is one command away and
// undoable from the toast; a label is never deleted, only archived, so the
// history keeps its name.
type Fields = { name: string; color: string; description: string };
const DEFAULT_COLOR = '#667085';
function LabelForm({
  initial,
  slugPreview,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: Fields;
  /** Slug of a new label, derived from the name; absent when editing. */
  slugPreview?: (name: string) => string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (fields: Fields) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState(initial.color);
  const [description, setDescription] = useState(initial.description);
  const ready = name.trim().length > 0 && description.trim().length > 0;
  return (
    <form
      className="label-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready)
          onSubmit({
            name: name.trim(),
            color,
            description: description.trim(),
          });
      }}
    >
      <fieldset disabled={busy}>
        <div className="label-form-row">
          <Input
            aria-label="Название метки"
            placeholder="Название метки"
            maxLength={LIMITS.labelName}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="color-field"
            type="color"
            aria-label="Цвет метки"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        </div>
        {slugPreview && name.trim() && (
          <p className="label-slug">
            Слаг для агентов: <code>{slugPreview(name.trim())}</code>
          </p>
        )}
        <Textarea
          aria-label="Когда ставить метку"
          placeholder="Когда ставить метку: по этому описанию её выбирают агенты"
          maxLength={LIMITS.labelDescription}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="label-form-actions">
          <Button type="submit" disabled={!ready}>
            {submitLabel}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Отмена
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
export function LabelsDialog({
  labels,
  tasks,
  onClose,
}: {
  labels: Label[];
  tasks: Task[];
  onClose: () => void;
}) {
  const commands = useWorkspaceCommands();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = labels.filter((l) => !l.archivedAt);
  const archived = labels.filter((l) => l.archivedAt);
  const usage = new Map<string, number>();
  for (const task of tasks)
    if (!task.archived && task.status !== 'done')
      for (const id of task.labels) usage.set(id, (usage.get(id) ?? 0) + 1);
  const taken = new Set(labels.map((l) => l.id));
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      setEditing(null);
      setCreating(false);
    } catch (error_) {
      setError(
        error_ instanceof Error ? error_.message : 'Не удалось сохранить.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
    >
      <DialogContent className="create-dialog labels-dialog">
        <DialogHeader>
          <DialogTitle>Метки</DialogTitle>
          <DialogDescription>
            Метки заводит владелец; агенты выбирают их по описанию. Лишнюю метку
            лучше убрать в архив: с задач она снимется сама.
          </DialogDescription>
        </DialogHeader>
        <ul className="label-list">
          {active.map((label) => (
            <li key={label.id} className="label-row">
              {editing === label.id ? (
                <LabelForm
                  initial={label}
                  submitLabel="Сохранить"
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSubmit={(fields) =>
                    run(() => commands.saveLabel({ ...label, ...fields }))
                  }
                />
              ) : (
                <>
                  <span
                    className="label-chip label-preview"
                    style={
                      { '--chip-color': label.color } as React.CSSProperties
                    }
                  >
                    <span
                      className="tag-dot"
                      style={{ background: label.color }}
                    />
                    {label.name}
                  </span>
                  <span className="label-description">{label.description}</span>
                  <span className="label-usage">
                    {usage.get(label.id)
                      ? taskCount(usage.get(label.id)!)
                      : 'не используется'}
                  </span>
                  <span className="label-actions">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Изменить метку ${label.name}`}
                      disabled={busy}
                      onClick={() => {
                        setCreating(false);
                        setEditing(label.id);
                      }}
                    >
                      <Pencil size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`В архив: метка ${label.name}`}
                      disabled={busy}
                      onClick={() => run(() => commands.archiveLabel(label))}
                    >
                      <Archive size={15} />
                    </Button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
        {creating ? (
          <LabelForm
            initial={{ name: '', color: DEFAULT_COLOR, description: '' }}
            slugPreview={(name) => uniqueSlug(name, taken)}
            submitLabel="Добавить метку"
            busy={busy}
            onCancel={() => setCreating(false)}
            onSubmit={(fields) =>
              run(() =>
                commands.saveLabel({
                  ...fields,
                  id: uniqueSlug(fields.name, taken),
                  revision: 0,
                }),
              )
            }
          />
        ) : (
          <Button
            variant="outline"
            className="label-add"
            disabled={busy || active.length >= LIMITS.labels}
            onClick={() => {
              setEditing(null);
              setCreating(true);
            }}
          >
            <Plus size={15} />
            Новая метка
          </Button>
        )}
        {archived.length > 0 && (
          <details className="label-archive">
            <summary>
              <Archive size={14} />В архиве: {archived.length}
            </summary>
            <ul className="label-list">
              {archived.map((label) => (
                <li key={label.id} className="label-row">
                  <span className="label-chip label-preview label-archived">
                    {label.name}
                  </span>
                  <span className="label-description">{label.description}</span>
                  <span className="label-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Вернуть метку ${label.name}`}
                      disabled={busy || active.length >= LIMITS.labels}
                      onClick={() => run(() => commands.restoreLabel(label))}
                    >
                      <ArchiveRestore size={15} />
                      Вернуть
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <p className="label-hint">
          <Undo2 size={13} /> Любое действие можно отменить из уведомления.
        </p>
      </DialogContent>
    </Dialog>
  );
}
