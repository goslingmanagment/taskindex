import { useState } from 'react';
import type { Task } from '@shared/model';
import { readDraft } from '../drafts';
import { useDraft } from '../use-draft';
import { workspaceStore } from '../store';
import { editorBaseRevision } from '../editor-base';
// TI-059 (план 07, шаг 13): состояние формы карточки. Редактор рисует, этот хук
// помнит: что правит владелец, от какой подтверждённой базы, какой шаг набран и
// какое сохранение уже ушло на сервер.
type Submission = { task: Task; base: Task; signature: string };
type TaskDraftFields = {
  task: Partial<Task>;
  step: string;
  submission?: Submission;
};
const serialize = (value: unknown) => JSON.stringify(value);
export function useTaskDraft(task: Task, confirmed: Task) {
  const [generation] = useState(() => workspaceStore.getSnapshot().generation);
  const [restored] = useState(() => readDraft<TaskDraftFields>(task.id));
  // Черновик от прежней версии базы не подставляется: записи там другие.
  const fromOtherGeneration =
    restored !== null && restored.generation !== generation;
  const own = fromOtherGeneration ? null : restored;
  const [draft, setDraft] = useState<Task>(() => ({
    ...confirmed,
    ...own?.fields.task,
  }));
  // TI-007: база всегда подтверждённая; восстановленный черновик может только
  // опустить её ревизию, но не поднять.
  const [base, setBase] = useState<Task>(() => ({
    ...confirmed,
    revision: editorBaseRevision(own?.baseRevision, confirmed),
  }));
  const [step, setStep] = useState(own?.fields.step ?? '');
  const [submission, setSubmission] = useState<Submission | null>(
    own?.fields.submission ?? null,
  );
  const dirty = serialize(draft) !== serialize(base) || step.trim().length > 0;
  const changed = Object.fromEntries(
    Object.entries(draft).filter(
      ([key, value]) => serialize(value) !== serialize(base[key as keyof Task]),
    ),
  ) as Partial<Task>;
  const storage = useDraft<TaskDraftFields>(
    task.id,
    { task: changed, step, ...(submission ? { submission } : {}) },
    { enabled: dirty, baseRevision: base.revision, id: task.id },
  );
  return {
    draft,
    base,
    step,
    submission,
    dirty,
    fromOtherGeneration,
    restored,
    storage,
    ref: storage.ref,
    dispatch: storage.dispatch,
    patch: (part: Partial<Task>) => setDraft((d) => ({ ...d, ...part })),
    setStep,
    setSubmission,
    /** Сохранение прошло: форма встаёт на новую подтверждённую запись. */
    accept(next: Task) {
      setSubmission(null);
      setDraft(next);
      setBase(next);
      setStep('');
      storage.clear();
    },
    /** Совмещение версий: свои правки поверх актуальной записи. */
    merge(current: Task) {
      const mine = Object.fromEntries(
        Object.entries(draft).filter(
          ([key, value]) =>
            key !== 'revision' &&
            serialize(value) !== serialize(base[key as keyof Task]),
        ),
      );
      setDraft({ ...current, ...mine, revision: current.revision });
      setBase(current);
    },
    /** Ответ «базовая версия из будущего»: откат к подтверждённой ревизии. */
    lowerBase(revision: number) {
      setBase((b) => ({ ...b, revision }));
    },
  };
}
export type TaskDraft = ReturnType<typeof useTaskDraft>;
