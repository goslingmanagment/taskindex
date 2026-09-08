'use client';
import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Choice } from './task-editor';
import {
  AREAS,
  STATUSES,
  type AreaId,
  type Project,
  type Status,
  type Task,
} from '@/lib/workspace';
function useDraftText(key: string, initial: string) {
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(key) ?? initial;
    } catch {
      return initial;
    }
  });
  const cleared = useRef(false);
  useEffect(() => {
    if (!cleared.current)
      try {
        sessionStorage.setItem(key, text);
      } catch {}
  }, [key, text]);
  const clear = () => {
    cleared.current = true;
    try {
      sessionStorage.removeItem(key);
    } catch {}
  };
  return [text, setText, clear] as const;
}
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
  onSave: (t: Task) => Promise<Task>;
}) {
  const [title, setTitle, clearDraft] = useDraftText(
    `task-draft/${area}/${projectId}/${status}`,
    '',
  );
  const [selected, setSelected] = useState(
      projectId === 'all' ? '' : projectId,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [draftId, , clearId] = useDraftText(
    `task-draft-id/${area}/${projectId}/${status}`,
    crypto.randomUUID(),
  );
  async function submit() {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await onSave({
        id: draftId,
        area,
        projectId: selected,
        title: title.trim(),
        status,
        note: '',
        due: '',
        waitingFor: '',
        followUp: '',
        checklist: [],
        rank: Date.now() / 1000,
        demo: false,
        archived: false,
        revision: 0,
      });
      clearDraft();
      clearId();
      onClose();
    } catch (e) {
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
            <Input
              aria-label="Что нужно сделать?"
              placeholder="Что нужно сделать?"
              maxLength={240}
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
                {' '}
                <Choice
                  label="Направление новой задачи"
                  value={selected || 'none'}
                  onChange={(v) => setSelected(v === 'none' ? '' : v)}
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
  onSave: (p: Project) => Promise<Project>;
}) {
  const [name, setName, clearDraft] = useDraftText(
    `project-draft/${area}/${project?.id || 'new'}`,
    project?.name || '',
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const id = useRef(project?.id || crypto.randomUUID());
  const title = area === 'development' ? 'проект' : 'направление';
  async function submit() {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError('');
    try {
      await onSave({
        id: id.current,
        area,
        name: name.trim(),
        color: project?.color || AREAS.find((a) => a.id === area)!.color,
        revision: project?.revision || 0,
      });
      clearDraft();
      onClose();
    } catch (e) {
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
          <DialogTitle>
            {project ? 'Переименовать' : 'Добавить'} {title}
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
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
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
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? 'Сохраняем…' : project ? 'Сохранить' : 'Добавить'}
              </Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
