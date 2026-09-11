import { useState } from 'react';
import { LIMITS } from '@shared/limits';
import { Plus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { Button } from '../ui/button';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '../ui/collapsible';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Choice } from './editor/choice';
import {
  AREAS,
  STATUSES,
  type AreaId,
  type Project,
  type Status,
  type Task,
} from '@shared/model';
import { readDraft } from './drafts';
import { useDraft } from './use-draft';
import { workspaceStore } from './store';
import { ApiError } from './api';
import { ConflictPanel } from './conflict-panel';
import type { NewTask } from './commands';
type QuickFields = { title: string; projectId: string | null };
export function QuickCreate({
  area,
  projectId,
  status,
  projects,
  onClose,
  onSave,
}: {
  area: AreaId;
  projectId: string;
  status: Status;
  projects: Project[];
  onClose: () => void;
  onSave: (task: NewTask, operationId: string) => Promise<Task>;
}) {
  const key = `new/${area}/${projectId}/${status}`;
  const defaultProject =
    projectId === 'all' || projectId === 'none' ? null : projectId;
  const [restored] = useState(() => readDraft<QuickFields>(key));
  const [generation] = useState(() => workspaceStore.getSnapshot().generation);
  const own = restored && restored.generation === generation ? restored : null;
  const [title, setTitle] = useState(own?.fields.title ?? '');
  const [selected, setSelected] = useState<string | null>(
    own?.fields.projectId ?? defaultProject,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  // План 07, §3.9: черновик пишется, только когда в форме что-то есть. Пустая
  // форма, открытая и закрытая, не оставляет записи `title: ''`.
  const draft = useDraft<QuickFields>(
    key,
    { title, projectId: selected },
    { enabled: title.trim().length > 0 || selected !== defaultProject },
  );
  async function submit() {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const signature = JSON.stringify({ title: title.trim(), selected });
      // TI-023: правка после окончательного отказа делает операцию другой.
      draft.dispatch({ type: 'edit', signature });
      const sending = draft.dispatch({ type: 'send', signature });
      await onSave(
        {
          id: draft.entity.current,
          area,
          projectId: selected,
          title: title.trim(),
          status,
        },
        sending.operationId,
      );
      draft.dispatch({ type: 'success' });
      draft.clear();
      onClose();
    } catch (error_) {
      // TI-023: новый идентификатор операции появится только после правки
      // текста, и только если отказ был окончательным.
      draft.dispatch({
        type: 'reject',
        retryable: !(error_ instanceof ApiError) || error_.detail.retryable,
      });
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
      <DialogContent className="create-dialog">
        <DialogHeader>
          <DialogTitle>Новая задача</DialogTitle>
          <DialogDescription>
            {AREAS.find((a) => a.id === area)?.name}{' '}
            <span className="dialog-separator">/</span>{' '}
            {STATUSES.find((s) => s.id === status)?.name}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={busy}>
            {draft.foreign && draft.restored && (
              <details className="conflict-box">
                <summary>Черновик от прежней версии базы</summary>
                <p>{draft.restored.fields.title}</p>
              </details>
            )}
            <Input
              aria-label="Что нужно сделать?"
              placeholder="Что нужно сделать?"
              maxLength={LIMITS.taskTitle}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="quick-title"
            />
            <Collapsible defaultOpen={!projectId || projectId === 'all'}>
              <div className="quick-context">
                <span>
                  {projects.find((p) => p.id === selected)?.name ||
                    'Без направления'}
                </span>
                <CollapsibleTrigger render={<Button variant="ghost" />}>
                  Изменить
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent className="quick-project-choice">
                <Choice
                  id="new-task-project"
                  label="Направление новой задачи"
                  value={selected || 'none'}
                  onChange={(v) => setSelected(v === 'none' ? null : v)}
                  items={[
                    { value: 'none', label: 'Без направления' },
                    ...projects
                      .filter((p) => p.area === area)
                      .map((p) => ({ value: p.id, label: p.name })),
                  ]}
                />
              </CollapsibleContent>
            </Collapsible>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <span>Черновик сохранится при закрытии</span>
              <Button type="submit" disabled={busy || !title.trim()}>
                <Plus />
                {busy ? 'Добавляем…' : 'Добавить'}
              </Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
type ProjectFields = {
  name: string;
  description: string;
  color: string;
  base?: Project;
  conflict?: Project | null;
};
export function ProjectDialog({
  area,
  project,
  onClose,
  onSave,
}: {
  area: AreaId;
  project?: Project;
  onClose: () => void;
  onSave: (project: Project, operationId: string) => Promise<Project>;
}) {
  const key = `project/${area}/${project?.id || 'new'}`;
  const [restored] = useState(() => readDraft<ProjectFields>(key));
  const [generation] = useState(() => workspaceStore.getSnapshot().generation);
  const valid = restored?.generation === generation ? restored : null;
  const [base, setBase] = useState(
    () =>
      valid?.fields.base ??
      (project && {
        ...project,
        revision: valid?.baseRevision ?? project.revision,
      }),
  );
  const [conflict, setConflict] = useState<Project | null>(
    () =>
      valid?.fields.conflict ??
      (project && valid && project.revision !== valid.baseRevision
        ? project
        : null),
  );
  const defaults = {
    name: project?.name ?? '',
    description: project?.description ?? '',
    color: project?.color ?? AREAS.find((a) => a.id === area)!.color,
  };
  const [name, setName] = useState(valid?.fields.name ?? defaults.name);
  const [description, setDescription] = useState(
    valid?.fields.description ?? defaults.description,
  );
  const [color, setColor] = useState(valid?.fields.color ?? defaults.color);
  const [id, setId] = useState(project?.id ?? valid?.id ?? crypto.randomUUID());
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const dirty =
    name !== defaults.name ||
    description !== defaults.description ||
    color !== defaults.color ||
    conflict !== null;
  const draft = useDraft<ProjectFields>(
    key,
    { name, description, color, base, conflict },
    { enabled: dirty, baseRevision: base?.revision ?? 0, id },
  );
  const title = area === 'development' ? 'проект' : 'направление';
  // TI-040: после перехода на существующую запись диалог продолжает работать
  // как переименование, в том числе после перезагрузки — id лежит в черновике.
  const editing = Boolean(project ?? base);
  // Создание упёрлось в занятое имя: сервер прислал ту самую запись.
  const duplicate = !editing && conflict !== null;
  const signature = () =>
    JSON.stringify({ name: name.trim(), description, color, id });
  async function submit() {
    if (busy || conflict || !name.trim()) return;
    setBusy(true);
    setError('');
    try {
      draft.dispatch({ type: 'edit', signature: signature() });
      const sending = draft.dispatch({ type: 'send', signature: signature() });
      await onSave(
        {
          id,
          area,
          name: name.trim(),
          description,
          color,
          revision: base?.revision ?? 0,
          createdAt: project?.createdAt ?? '',
          updatedAt: project?.updatedAt ?? '',
        },
        sending.operationId,
      );
      draft.dispatch({ type: 'success' });
      draft.clear();
      onClose();
    } catch (error_) {
      draft.dispatch({
        type: 'reject',
        retryable: !(error_ instanceof ApiError) || error_.detail.retryable,
      });
      if (error_ instanceof ApiError && error_.status === 409 && error_.current)
        setConflict(error_.current as Project);
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
      <DialogContent className="create-dialog project-dialog">
        <DialogHeader>
          <DialogTitle>
            {editing ? 'Переименовать' : 'Добавить'} {title}
          </DialogTitle>
          <DialogDescription>
            {AREAS.find((a) => a.id === area)?.name}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={busy}>
            <Input
              aria-label="Название направления"
              placeholder={
                area === 'development'
                  ? 'Например, новый продукт'
                  : 'Название направления'
              }
              maxLength={LIMITS.projectName}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <label
              className="project-description"
              htmlFor="project-description"
            >
              Что относится к направлению
              <Textarea
                id="project-description"
                aria-label="Описание направления"
                maxLength={LIMITS.projectDescription}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label className="project-color" htmlFor="project-color">
              Цвет{' '}
              <input
                id="project-color"
                className="color-field"
                type="color"
                aria-label="Цвет направления"
                value={color}
                onChange={(e) => setColor(e.target.value)}
              />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {duplicate && conflict && (
              <div className="conflict-box project-conflict">
                <strong>
                  Такое {title} уже есть: {conflict.name}
                </strong>
                <p>
                  Можно открыть существующее и переименовать его, не создавая
                  второе с тем же именем.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setBase(conflict);
                    setId(conflict.id);
                    setName(conflict.name);
                    setDescription(conflict.description);
                    setColor(conflict.color);
                    setConflict(null);
                    draft.dispatch({ type: 'success' });
                    setError('');
                  }}
                >
                  Открыть существующее
                </Button>
              </div>
            )}
            {conflict && !duplicate && (
              <ConflictPanel
                className="project-conflict"
                summary={
                  <dl>
                    <dt>Название</dt>
                    <dd>{conflict.name}</dd>
                    <dt>Описание</dt>
                    <dd>{conflict.description || 'Без описания'}</dd>
                    <dt>Цвет</dt>
                    <dd>{conflict.color}</dd>
                  </dl>
                }
                note="Оставим изменённые тобой поля, остальные возьмём из актуальной версии. Перед сохранением проверь результат."
                onMerge={() => {
                  if (base) {
                    if (name === base.name) setName(conflict.name);
                    if (description === base.description)
                      setDescription(conflict.description);
                    if (color === base.color) setColor(conflict.color);
                  }
                  setBase(conflict);
                  setConflict(null);
                  draft.dispatch({ type: 'success' });
                  setError('');
                }}
              />
            )}
            <div className="dialog-actions">
              <Button
                variant="ghost"
                type="button"
                onClick={onClose}
                disabled={busy}
              >
                Отмена
              </Button>
              <Button
                type="submit"
                disabled={busy || !!conflict || !name.trim()}
              >
                {busy ? 'Сохраняем…' : project ? 'Сохранить' : 'Добавить'}
              </Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
