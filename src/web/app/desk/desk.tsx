import { useEffect, useMemo } from 'react';
import type { Task } from '@shared/model';
import { Button } from '../../ui/button';
import { toast } from '../../ui/toast';
import { useWorkspace } from '../use-workspace';
import { useWorkspaceCommands } from '../use-workspace-commands';
import { useNavigation } from '../navigation';
import { checklistToggleCommand, taskFocusCommand } from '../commands';
import { deskOf } from '../selectors';
import { DeskCurrent } from './desk-current';
import { DeskNext } from './desk-next';
import { DeskRail } from './desk-rail';
import { ContextsDrawer } from './contexts-drawer';
// TI-078 (план 13, шаги 8–9): вид «Стол» на экране Focus. Данные — чистый
// селектор `focusDesk` по задачам пространства: тот же расчёт, что у
// `GET /api/focus`, но живой, потому что store уже держит все задачи и получает
// события потоком. Клавиатура: пробел отмечает шаг, N берёт следующую.
export function Desk() {
  const { data, today } = useWorkspace();
  const { location, update, openTask } = useNavigation();
  const commands = useWorkspaceCommands();
  const desk = useMemo(() => deskOf(data.tasks, today), [data.tasks, today]);
  const { current, next } = desk;
  const safely = (promise: Promise<unknown>) =>
    void promise.catch((error: Error) =>
      toast.add({ title: error.message, type: 'error' }),
    );
  const toggleStep = (task: Task, itemId: string, done: boolean) =>
    safely(
      commands.execute(
        checklistToggleCommand(task, itemId, done),
        done ? 'Шаг отмечен' : 'Отметка снята',
      ),
    );
  const take = (task: Task) =>
    safely(
      commands.execute(
        taskFocusCommand(task, { first: true }),
        'Задача в фокусе',
      ),
    );
  const complete = (task: Task) =>
    safely(commands.setStatus(task, 'done', 'Задача готова'));
  const openContexts = (parked: boolean) =>
    update({ contexts: true, status: parked ? 'todo' : '', parked });
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.matches('input,textarea,select,button') ||
        target.isContentEditable ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        location.contexts ||
        location.task
      )
        return;
      if (e.key === ' ' && current) {
        const step = current.checklist.find((c) => !c.done);
        if (!step) return;
        e.preventDefault();
        toggleStep(current, step.id, true);
      } else if (e.key.toLowerCase() === 'n' && next[0]) {
        e.preventDefault();
        take(next[0]);
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  });
  return (
    <div className="desk">
      <div className="desk-workbench">
        <div className="desk-main">
          <DeskCurrent
            task={current}
            project={data.projects.find((p) => p.id === current?.projectId)}
            onToggleStep={toggleStep}
            onOpen={(task) => openTask(task.id)}
            onComplete={complete}
            onBrowse={() => openContexts(true)}
          />
          <DeskNext tasks={next} projects={data.projects} onTake={take} />
        </div>
        <DeskRail recent={desk.recent} projects={data.projects} onTake={take} />
      </div>
      <footer className="desk-footer">
        <span>Пробел отмечает шаг, N берёт следующую задачу</span>
        <Button variant="ghost" onClick={() => openContexts(true)}>
          Отложенные контексты
          <span aria-hidden="true">{desk.counts.parked || ''}</span>
        </Button>
      </footer>
      {location.contexts && (
        <ContextsDrawer onOpenTask={(task) => openTask(task.id)} />
      )}
    </div>
  );
}
