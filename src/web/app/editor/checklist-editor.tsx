import { ArrowUpRight, ListChecks, Plus, X } from 'lucide-react';
import { LIMITS } from '@shared/limits';
import type { ChecklistItem, Task } from '@shared/model';
import { draftChecklistItem } from '@shared/steps';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { Input } from '../../ui/input';
import { Progress } from '../../ui/progress';
import { useNavigation } from '../navigation';
import { useWorkspace } from '../use-workspace';
import { stepByline } from '../step-meta';
// Шаги карточки: список, прогресс и строка добавления (план 07, шаг 13).
// TI-095: под отмеченным шагом подпись исполнителя, у шага строка итога и
// чип задачи, в которую он вырос; «В задачу» выносит шаг отдельной операцией.
export function ChecklistEditor({
  draft,
  patch,
  step,
  setStep,
  onPromote,
}: {
  draft: Task;
  patch: (part: Partial<Task>) => void;
  /** Набранный, но ещё не добавленный шаг: он же уходит при сохранении. */
  step: string;
  setStep: (value: string) => void;
  /** Вынос шага в задачу; undefined, пока карточка не сохранена. */
  onPromote?: (item: ChecklistItem) => void;
}) {
  const { data, timezone } = useWorkspace();
  const { openTask } = useNavigation();
  const done = draft.checklist.filter((c) => c.done).length;
  const linkedTitle = (id: string) =>
    data.tasks.find((t) => t.id === id)?.title ?? 'задача';
  return (
    <section className="detail-section">
      <h3>
        <ListChecks size={18} />
        Шаги
        <span>
          {done} / {draft.checklist.length}
        </span>
      </h3>
      {draft.checklist.length > 0 && (
        <Progress
          className="checklist-progress"
          aria-label="Выполненные шаги"
          value={(done / draft.checklist.length) * 100}
        />
      )}
      {draft.checklist.map((c) => {
        const byline = stepByline(c, timezone);
        const meta = byline || c.result || c.done || c.linkedTaskId;
        return (
          <div className="checklist-item" key={c.id}>
            <div className="checklist-row">
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
                maxLength={LIMITS.checklistText}
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
              {c.linkedTaskId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="step-link"
                  aria-label={'Открыть задачу ' + linkedTitle(c.linkedTaskId)}
                  onClick={() => openTask(c.linkedTaskId!)}
                >
                  <ArrowUpRight size={13} />
                  {linkedTitle(c.linkedTaskId)}
                </Button>
              ) : (
                onPromote &&
                c.revision > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={'В задачу: ' + c.text}
                    title="Вынести шаг в отдельную задачу"
                    onClick={() => onPromote(c)}
                  >
                    <ArrowUpRight size={14} />
                  </Button>
                )
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={'Убрать шаг ' + c.text}
                onClick={() =>
                  patch({
                    checklist: draft.checklist.filter((i) => i.id !== c.id),
                  })
                }
              >
                <X size={14} />
              </Button>
            </div>
            {meta && (
              <div className="step-meta">
                {byline && <span className="step-byline">{byline}</span>}
                <Input
                  aria-label={'Итог шага ' + c.text}
                  className="step-result"
                  placeholder="Итог шага…"
                  maxLength={LIMITS.stepResult}
                  value={c.result}
                  onChange={(e) =>
                    patch({
                      checklist: draft.checklist.map((i) =>
                        i.id === c.id ? { ...i, result: e.target.value } : i,
                      ),
                    })
                  }
                />
              </div>
            )}
          </div>
        );
      })}
      <form
        className="new-step"
        onSubmit={(e) => {
          e.preventDefault();
          if (step.trim()) {
            patch({
              checklist: [
                ...draft.checklist,
                draftChecklistItem(crypto.randomUUID(), step.trim()),
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
          maxLength={LIMITS.checklistText}
          onChange={(e) => setStep(e.target.value)}
        />
        <Button
          type="submit"
          variant="ghost"
          aria-label="Добавить шаг"
          disabled={
            !step.trim() || draft.checklist.length >= LIMITS.checklistItems
          }
        >
          <Plus />
        </Button>
      </form>
    </section>
  );
}
