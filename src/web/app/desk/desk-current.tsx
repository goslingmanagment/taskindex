import { ArrowUpRight, Check } from 'lucide-react';
import type { Project, Task } from '@shared/model';
import { AREAS } from '@shared/model';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { Progress } from '../../ui/progress';
import { Empty, EmptyTitle, EmptyDescription } from '../../ui/empty';
import { useWorkspace } from '../use-workspace';
import { stepByline } from '../step-meta';
// TI-078 (план 13, шаг 8): текущая задача стола. Один заголовок, одно следующее
// действие и шаги — экран отвечает на вопрос «чем я занят сейчас», а не
// показывает список.
export function DeskCurrent({
  task,
  project,
  onToggleStep,
  onOpen,
  onComplete,
  onBrowse,
}: {
  task: Task | null;
  project?: Project;
  onToggleStep: (task: Task, itemId: string, done: boolean) => void;
  onOpen: (task: Task) => void;
  onComplete: (task: Task) => void;
  /** Стол пуст: предложить выбрать задачу из ящика контекстов. */
  onBrowse: () => void;
}) {
  const { timezone } = useWorkspace();
  if (!task)
    return (
      <section className="desk-card desk-empty" aria-label="Текущая задача">
        <Empty>
          <EmptyTitle>Стол свободен</EmptyTitle>
          <EmptyDescription>
            Возьмите задачу в фокус — она станет текущей и появится здесь.
          </EmptyDescription>
          <Button variant="outline" onClick={onBrowse}>
            Выбрать задачу
          </Button>
        </Empty>
      </section>
    );
  const done = task.checklist.filter((c) => c.done).length;
  const next = task.checklist.find((c) => !c.done);
  return (
    <section className="desk-card" aria-label="Текущая задача">
      <div className="desk-card-top">
        <span className="desk-eyebrow">В фокусе · сейчас</span>
        <span className="desk-card-hint">
          {task.checklist.length
            ? 'Можно остановиться на любом шаге'
            : 'Один следующий шаг'}
        </span>
      </div>
      <div className="desk-project-line">
        {project && <b>{project.name}</b>}
        <span>{AREAS.find((a) => a.id === task.area)?.name}</span>
      </div>
      <h2 className="desk-title">{task.title}</h2>
      <div className="desk-next-action">
        <span aria-hidden="true">↳</span>
        <div>
          <small>Следующее действие</small>
          <p>
            {next?.text ??
              (task.note.split('\n')[0] || 'Откройте карточку и запишите шаг.')}
          </p>
        </div>
      </div>
      {task.checklist.length > 0 && (
        <div className="desk-steps">
          <div className="desk-steps-head">
            <span>
              Шаги {done} из {task.checklist.length}
            </span>
            <Progress
              className="desk-progress"
              aria-label="Выполненные шаги"
              value={(done / task.checklist.length) * 100}
            />
          </div>
          {task.checklist.map((item) => {
            const byline = stepByline(item, timezone);
            return (
              <label className="desk-step" key={item.id}>
                <Checkbox
                  checked={item.done}
                  aria-label={'Выполнено: ' + item.text}
                  onCheckedChange={(v) => onToggleStep(task, item.id, !!v)}
                />
                <span className="desk-step-body">
                  <span className={item.done ? 'step-done' : ''}>
                    {item.text}
                  </span>
                  {(byline || item.result) && (
                    <small className="desk-step-meta">
                      {byline}
                      {byline && item.result ? ' · ' : ''}
                      {item.result}
                    </small>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}
      <div className="desk-card-footer">
        <Button variant="ghost" onClick={() => onOpen(task)}>
          Контекст задачи
          <ArrowUpRight size={15} />
        </Button>
        <Button variant="outline" onClick={() => onComplete(task)}>
          <Check size={15} />
          Задача готова
        </Button>
      </div>
    </section>
  );
}
