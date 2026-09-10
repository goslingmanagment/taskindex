import { Clock3 } from 'lucide-react';
import { LIMITS } from '@shared/limits';
import type { Task } from '@shared/model';
import { Input } from '../../ui/input';
// «Жду»: от кого ждём и когда вернуться к задаче (план 07, шаг 13).
export function WaitingSection({
  draft,
  patch,
}: {
  draft: Task;
  patch: (part: Partial<Task>) => void;
}) {
  return (
    <section className="waiting-editor">
      <h3>
        <Clock3 size={17} />
        Чего ждём?
      </h3>
      <Input
        aria-label="От кого или чего ждём"
        placeholder="Например, ответ дизайнера"
        maxLength={LIMITS.taskTitle}
        value={draft.waitingFor}
        onChange={(e) => patch({ waitingFor: e.target.value })}
      />
      <label htmlFor="task-follow-up">
        Когда вернуться к задаче
        <input
          id="task-follow-up"
          className="date-field"
          type="date"
          value={draft.followUp || ''}
          onChange={(e) => patch({ followUp: e.target.value || null })}
        />
      </label>
      <p>Это дата проверки, а не дедлайн.</p>
    </section>
  );
}
