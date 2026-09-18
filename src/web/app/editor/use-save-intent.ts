import { useState } from 'react';
import type { Task } from '@shared/model';
import { draftChecklistItem } from '@shared/steps';
import { ApiError } from '../api';
import { workspaceStore } from '../store';
import { isFutureBaseError } from '../editor-base';
import { notify, useWorkspaceCommands } from '../use-workspace-commands';
import type { TaskDraft } from './use-task-draft';
// TI-023 (план 07, шаг 13 и доп. 25): отправка карточки по таблице состояний
// намерения. Один конверт на одно намерение: пока сохранение не завершилось
// окончательно, повтор идёт с тем же `operationId`, а новый появляется только
// после окончательного отказа и правки текста.
export function useSaveIntent(
  form: TaskDraft,
  task: Task,
  /** TI-007: подтверждённая запись — к ней возвращается база при отказе. */
  confirmed: Task,
  onClose: () => void,
) {
  const commands = useWorkspaceCommands();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [conflict, setConflict] = useState<Task | null>(null);
  const signature = () =>
    JSON.stringify({ draft: form.draft, step: form.step });
  async function save(close = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const current = signature();
      // Ушедшее сохранение и другой текст в форме: сначала владелец решает
      // судьбу прошлого конверта, потом отправляет новый.
      if (form.submission && form.submission.signature !== current) {
        const state = workspaceStore.getSnapshot();
        if (
          !state.pending.some(
            (p) => p.envelope.operationId === form.ref.current.operationId,
          )
        ) {
          form.setSubmission(null);
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
      const withStep = form.step.trim()
        ? {
            ...form.draft,
            checklist: [
              ...form.draft.checklist,
              draftChecklistItem(crypto.randomUUID(), form.step.trim()),
            ],
          }
        : form.draft;
      const submission = form.submission ?? {
        task: { ...withStep, title: withStep.title.trim() },
        base: form.base,
        signature: current,
      };
      form.setSubmission(submission);
      // Правка после окончательного отказа делает операцию другой; после
      // неизвестного исхода идентификатор сохраняется.
      form.dispatch({ type: 'edit', signature: current });
      const sending = form.dispatch({ type: 'send', signature: current });
      form.storage.write({
        task: form.draft,
        step: form.step,
        submission,
      });
      const { task: next, result } = await commands.saveTask(
        submission.task,
        submission.base,
        sending.operationId,
      );
      notify(result, 'Изменения сохранены');
      form.dispatch({ type: 'success' });
      form.accept(next);
      if (close) onClose();
    } catch (error_) {
      const retryable =
        !(error_ instanceof ApiError) || error_.detail.retryable;
      form.dispatch({ type: 'reject', retryable });
      if (!retryable) form.setSubmission(null);
      if (error_ instanceof ApiError && error_.status === 409 && error_.current)
        setConflict(error_.current as Task);
      if (
        error_ instanceof ApiError &&
        error_.detail.code === 'invalid' &&
        isFutureBaseError(error_.detail.message)
      ) {
        // База обогнала сервер: возвращаемся на подтверждённую ревизию
        // (эффект черновика перепишет `baseRevision`) и предлагаем повтор.
        form.lowerBase(confirmed.revision);
        setError(
          'Версия карточки не совпала с сервером. Проверьте текст и сохраните ещё раз.',
        );
        return;
      }
      setError(error_ instanceof Error ? error_.message : 'Не сохранилось.');
    } finally {
      setBusy(false);
    }
  }
  async function run(action: () => Promise<unknown>, message: string) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      onClose();
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : message);
    } finally {
      setBusy(false);
    }
  }
  return {
    busy,
    error,
    conflict,
    setError,
    save,
    archive: () =>
      run(() => commands.toggleArchive(form.base), 'Не удалось убрать задачу.'),
    moveToQueueTop: () =>
      run(
        () => commands.moveToQueueTop(form.base),
        'Не удалось переместить задачу.',
      ),
    merge() {
      if (!conflict) return;
      form.merge(conflict);
      setConflict(null);
      setError('');
    },
  };
}
