import { ArrowUpRight } from 'lucide-react';
import type { Project, Task } from '@shared/model';
// TI-078 (план 13, шаг 8): «Потом» — следующие задачи стола. Выбор, а не список:
// нажатие переносит задачу в начало стола и делает её текущей.
export function DeskNext({
  tasks,
  projects,
  onTake,
}: {
  tasks: Task[];
  projects: Project[];
  onTake: (task: Task) => void;
}) {
  if (!tasks.length) return null;
  return (
    <section className="desk-next" aria-labelledby="desk-next-heading">
      <div className="desk-section-heading">
        <h3 id="desk-next-heading">
          {tasks.length === 1 ? 'Потом' : `Потом — один из ${tasks.length}`}
        </h3>
        <span>Можно выбрать, когда освободишься</span>
      </div>
      <div className="desk-choices">
        {tasks.map((task) => (
          <button
            type="button"
            className="desk-choice"
            key={task.id}
            aria-label={'Взять в фокус: ' + task.title}
            onClick={() => onTake(task)}
          >
            <span className="desk-choice-meta">
              <span>
                {projects.find((p) => p.id === task.projectId)?.name ??
                  'Без направления'}
              </span>
              <span>Следом</span>
            </span>
            <h4>{task.title}</h4>
            <span className="desk-choice-bottom">
              <span>
                {task.checklist.find((c) => !c.done)?.text ??
                  'Открыть и начать'}
              </span>
              <ArrowUpRight size={15} aria-hidden="true" />
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
