import { useEffect, useState } from 'react';
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
import { Choice } from './editor';
import {
  AREAS,
  STATUSES,
  makeTask,
  type AreaId,
  type Project,
  type Status,
  type Task,
} from '../lib/workspace';
import { readDraft, writeDraft, clearDraft } from './drafts';
import { workspaceStore } from './store';
import { ApiError } from './api';
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
  onSave: (task: Task, operationId: string) => Promise<Task>;
}) {
  const key = `new/${area}/${projectId}/${status}`,
    generation = workspaceStore.getSnapshot().generation;
  const [initial] = useState(() =>
    readDraft<{ title: string; projectId: string | null }>(key),
  );
  const foreign = initial && initial.generation !== generation;
  const [title, setTitle] = useState(
    foreign ? '' : initial?.fields.title || '',
  );
  const [selected, setSelected] = useState<string | null>(
    foreign
      ? null
      : (initial?.fields.projectId ??
          (projectId === 'all' || projectId === 'none' ? null : projectId)),
  );
  const [id] = useState(
    initial && !foreign && initial.id ? initial.id : crypto.randomUUID(),
  );
  const [operationId, setOperationId] = useState<string>(
    initial && !foreign && initial.operationId
      ? initial.operationId
      : crypto.randomUUID(),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (title || !foreign)
      writeDraft(key, {
        formatVersion: 1,
        generation,
        baseRevision: 0,
        fields: { title, projectId: selected },
        id,
        operationId,
      });
  }, [title, selected, key, generation, id, operationId, foreign]);
  async function submit() {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await onSave(
        makeTask(
          {
            id,
            area,
            projectId: selected,
            title: title.trim(),
            status,
          },
          workspaceStore.getSnapshot().actor,
        ),
        operationId,
      );
      clearDraft(key);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && !e.detail.retryable)
        setOperationId(crypto.randomUUID());
      setError(e instanceof Error ? e.message : 'Не удалось сохранить.');
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
            {foreign && (
              <details className="conflict-box">
                <summary>Черновик от прежней версии базы</summary>
                <p>{initial.fields.title}</p>
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
  const key = `project/${area}/${project?.id || 'new'}`,
    generation = workspaceStore.getSnapshot().generation;
  const [initial] = useState(() =>
    readDraft<{
      name: string;
      description: string;
      color: string;
      base?: Project;
      conflict?: Project | null;
    }>(key),
  );
  const valid = initial?.generation === generation ? initial : null;
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
  const [name, setName] = useState(valid?.fields.name ?? project?.name ?? '');
  const [description, setDescription] = useState(
    valid?.fields.description ?? project?.description ?? '',
  );
  const [color, setColor] = useState(
    valid?.fields.color ??
      project?.color ??
      AREAS.find((a) => a.id === area)!.color,
  );
  const [id, setId] = useState(project?.id ?? valid?.id ?? crypto.randomUUID()),
    [operationId, setOperationId] = useState<string>(
      valid?.operationId ?? crypto.randomUUID(),
    );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    writeDraft(key, {
      formatVersion: 1,
      generation,
      baseRevision: base?.revision ?? 0,
      fields: { name, description, color, base, conflict },
      id,
      operationId,
    });
  }, [
    key,
    generation,
    base,
    conflict,
    name,
    description,
    color,
    id,
    operationId,
  ]);
  const title = area === 'development' ? 'проект' : 'направление';
  // TI-040: после перехода на существующую запись диалог продолжает работать
  // как переименование, в том числе после перезагрузки — id лежит в черновике.
  const editing = Boolean(project ?? base);
  // Создание упёрлось в занятое имя: сервер прислал ту самую запись.
  const duplicate = !editing && conflict !== null;
  async function submit() {
    if (busy || conflict || !name.trim()) return;
    setBusy(true);
    setError('');
    try {
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
        operationId,
      );
      clearDraft(key);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && !e.detail.retryable)
        setOperationId(crypto.randomUUID());
      if (e instanceof ApiError && e.status === 409 && e.current)
        setConflict(e.current as Project);
      setError(e instanceof Error ? e.message : 'Не удалось сохранить.');
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
            <label className="project-color">
              Цвет{' '}
              <input
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
            {duplicate && (
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
                    setOperationId(crypto.randomUUID());
                    setError('');
                  }}
                >
                  Открыть существующее
                </Button>
              </div>
            )}
            {conflict && !duplicate && (
              <div className="conflict-box project-conflict">
                <strong>Актуальная версия</strong>
                <dl>
                  <dt>Название</dt>
                  <dd>{conflict.name}</dd>
                  <dt>Описание</dt>
                  <dd>{conflict.description || 'Без описания'}</dd>
                  <dt>Цвет</dt>
                  <dd>{conflict.color}</dd>
                </dl>
                <p>
                  Оставим изменённые тобой поля, остальные возьмём из актуальной
                  версии. Перед сохранением проверь результат.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (base) {
                      if (name === base.name) setName(conflict.name);
                      if (description === base.description)
                        setDescription(conflict.description);
                      if (color === base.color) setColor(conflict.color);
                    }
                    setBase(conflict);
                    setConflict(null);
                    setOperationId(crypto.randomUUID());
                    setError('');
                  }}
                >
                  Совместить и проверить
                </Button>
              </div>
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
