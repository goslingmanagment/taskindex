import { ListChecks, Plus, X } from 'lucide-react';
import { LIMITS } from '@shared/limits';
import type { Task } from '@shared/model';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { Input } from '../../ui/input';
import { Progress } from '../../ui/progress';
// Шаги карточки: список, прогресс и строка добавления (план 07, шаг 13).
export function ChecklistEditor({
  draft,
  patch,
  step,
  setStep,
}: {
  draft: Task;
  patch: (part: Partial<Task>) => void;
  /** Набранный, но ещё не добавленный шаг: он же уходит при сохранении. */
  step: string;
  setStep: (value: string) => void;
}) {
  const done = draft.checklist.filter((c) => c.done).length;
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
      {draft.checklist.map((c) => (
        <div className="checklist-row" key={c.id}>
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
      ))}
      <form
        className="new-step"
        onSubmit={(e) => {
          e.preventDefault();
          if (step.trim()) {
            patch({
              checklist: [
                ...draft.checklist,
                { id: crypto.randomUUID(), text: step.trim(), done: false },
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
