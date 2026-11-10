import { useState } from 'react';
import type { Task } from '@shared/model';
import { readDraft, type Draft } from '../drafts';
import { useDraft } from '../use-draft';
import { workspaceStore } from '../store';
import {
  editorBaseRevision,
  restoreChecklist,
  stepRevisions,
} from '../editor-base';
// TI-059 (план 07, шаг 13): состояние формы карточки. Редактор рисует, этот хук
// помнит: что правит владелец, от какой подтверждённой базы, какой шаг набран и
// какое сохранение уже ушло на сервер.
type Submission = { task: Task; base: Task; signature: string };
type TaskDraftFields = {
  task: Partial<Task>;
  step: string;
  submission?: Submission;
  /** Revisions of the steps the draft started from (see `restoreChecklist`). */
  baseSteps?: Record<string, number>;
};
const serialize = (value: unknown) => JSON.stringify(value);
// 2026-11-10: a draft's checklist replaced the live one whole, so steps an
// agent ticked after the draft did not show and a save would undo them. The
// draft now goes over the live steps one by one, and the card says when the
// server moved on since the draft.
function restore(own: Draft<TaskDraftFields> | null, confirmed: Task) {
  if (!own) return { draft: confirmed, stale: false };
  const { task } = own.fields;
  const steps =
    task.checklist &&
    restoreChecklist(task.checklist, confirmed.checklist, own.fields.baseSteps);
  return {
    draft: {
      ...confirmed,
      ...task,
      ...(steps ? { checklist: steps.checklist } : {}),
    },
    stale: own.baseRevision < confirmed.revision || !!steps?.stale,
  };
}
export function useTaskDraft(task: Task, confirmed: Task) {
  const [generation] = useState(() => workspaceStore.getSnapshot().generation);
  const [restored] = useState(() => readDraft<TaskDraftFields>(task.id));
  // Черновик от прежней версии базы не подставляется: записи там другие.
  const fromOtherGeneration =
    restored !== null && restored.generation !== generation;
  const own = fromOtherGeneration ? null : restored;
  const [initial] = useState(() => restore(own, confirmed));
  const [draft, setDraft] = useState<Task>(initial.draft);
  // The card changed on the server after the draft was written.
  const [stale, setStale] = useState(initial.stale);
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
    {
      task: changed,
      step,
      ...(submission ? { submission } : {}),
      ...(changed.checklist
        ? { baseSteps: stepRevisions(base.checklist) }
        : {}),
    },
    { enabled: dirty, baseRevision: base.revision, id: task.id },
  );
  /** Сохранение прошло или черновик сброшен: форма встаёт на запись. */
  function accept(next: Task) {
    setSubmission(null);
    setDraft(next);
    setBase(next);
    setStep('');
    setStale(false);
    storage.clear();
  }
  return {
    draft,
    base,
    step,
    submission,
    dirty,
    stale,
    fromOtherGeneration,
    restored,
    storage,
    ref: storage.ref,
    dispatch: storage.dispatch,
    patch: (part: Partial<Task>) => setDraft((d) => ({ ...d, ...part })),
    setStep,
    setSubmission,
    accept,
    /** Сброс черновика: карточка показывает подтверждённую запись. */
    reset: () => accept(confirmed),
    /** Совмещение версий: свои правки поверх актуальной записи. */
    merge(current: Task) {
      const mine = Object.fromEntries(
        Object.entries(draft).filter(
          ([key, value]) =>
            key !== 'revision' &&
            serialize(value) !== serialize(base[key as keyof Task]),
        ),
      );
      if (mine.checklist)
        mine.checklist = restoreChecklist(
          draft.checklist,
          current.checklist,
          stepRevisions(base.checklist),
        ).checklist;
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
