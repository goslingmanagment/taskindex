import { ArrowUpRight } from 'lucide-react';
import type { Project, Task } from '@shared/model';
// Задачи, недавно ушедшие со стола: сохранённый контекст для возвращения.
export function DeskRail({
  recent,
  projects,
  onTake,
}: {
  recent: Task[];
  projects: Project[];
  onTake: (task: Task) => void;
}) {
  const name = (task: Task) =>
    projects.find((p) => p.id === task.projectId)?.name ?? 'Без направления';
  return (
    <aside className="desk-rail" aria-label="Сохранённые контексты">
      <section className="desk-rail-section" aria-labelledby="desk-recent">
        <h3 id="desk-recent">Легко вернуться</h3>
        <p className="desk-rail-caption">Следующий шаг уже сохранён</p>
        {recent.length === 0 && (
          <p className="desk-rail-empty">Пока нечего возвращать.</p>
        )}
        {recent.map((task) => (
          <button
            type="button"
            className="desk-resume-item"
            key={task.id}
            aria-label={'Вернуть в фокус: ' + task.title}
            onClick={() => onTake(task)}
          >
            <span>
              <span className="desk-resume-project">{name(task)}</span>
              <span className="desk-resume-title">{task.title}</span>
              <span className="desk-resume-note">
                {task.checklist.find((c) => !c.done)?.text ??
                  'Открыть и начать'}
              </span>
            </span>
            <ArrowUpRight size={15} aria-hidden="true" />
          </button>
        ))}
      </section>
    </aside>
  );
}
