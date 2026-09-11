import { ArrowUpRight } from 'lucide-react';
import type { Project, Task } from '@shared/model';
import { dateLabel } from '@shared/queries';
// TI-078 (план 13, шаг 8): правая колонка стола. «Жду от других» — ожидания с
// датой возврата, «Легко вернуться» — задачи, недавно ушедшие со стола.
export function DeskRail({
  waiting,
  recent,
  projects,
  today,
  onOpen,
  onTake,
}: {
  waiting: Task[];
  recent: Task[];
  projects: Project[];
  today: string;
  onOpen: (task: Task) => void;
  onTake: (task: Task) => void;
}) {
  const name = (task: Task) =>
    projects.find((p) => p.id === task.projectId)?.name ?? 'Без направления';
  return (
    <aside className="desk-rail" aria-label="Ожидания и сохранённые контексты">
      <section className="desk-rail-section" aria-labelledby="desk-waiting">
        <h3 id="desk-waiting">Жду от других</h3>
        <p className="desk-rail-caption">Вернуться в указанную дату</p>
        {waiting.length === 0 && (
          <p className="desk-rail-empty">Ничего не ждёт ответа.</p>
        )}
        {waiting.map((task) => (
          <button
            type="button"
            className="desk-waiting-item"
            key={task.id}
            onClick={() => onOpen(task)}
            aria-label={`${task.title}. ${
              task.waitingFor ? `Ждём: ${task.waitingFor}. ` : ''
            }${
              task.followUp
                ? `Вернуться ${dateLabel(task.followUp, today).toLowerCase()}`
                : 'Без даты возврата'
            }`}
          >
            <span className="desk-return-date">
              {task.followUp ? dateLabel(task.followUp, today) : '—'}
            </span>
            <span>
              <span className="desk-wait-title">{task.title}</span>
              <span className="desk-wait-person">
                {task.waitingFor || name(task)}
              </span>
            </span>
          </button>
        ))}
      </section>
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
