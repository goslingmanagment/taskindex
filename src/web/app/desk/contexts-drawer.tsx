import type { Task } from '@shared/model';
import { TASK_STATES as STATUSES, visibleStatus } from '../board-columns';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../../ui/dialog';
import { Choice } from '../editor/choice';
import { useNavigation } from '../navigation';
import { useWorkspace } from './../use-workspace';
import { taskCount } from '../labels';
// TI-078 (план 13, шаг 8): ящик «Все контексты» поверх стола. Фильтры живут в
// адресе, поэтому ссылку на «отложенные контексты» можно сохранить и переслать.
export function ContextsDrawer({
  onOpenTask,
}: {
  onOpenTask: (task: Task) => void;
}) {
  const { data } = useWorkspace();
  const { location, update } = useNavigation();
  const { parked } = location;
  const status = location.status === 'waiting' ? 'todo' : location.status;
  const tasks = data.tasks.filter(
    (t) =>
      !t.archived &&
      (status === '' || visibleStatus(t.status) === status) &&
      (!parked || t.focusKey === null),
  );
  const close = () => update({ contexts: false });
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <DialogContent className="contexts-drawer">
        <DialogHeader>
          <DialogTitle>Все контексты</DialogTitle>
          <DialogDescription>
            {taskCount(tasks.length)}
            {parked ? ' вне стола' : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="contexts-filters">
          <label htmlFor="contexts-status">
            Состояние
            <Choice
              id="contexts-status"
              label="Состояние задачи в ящике"
              value={status || 'all'}
              onChange={(v) => update({ status: v === 'all' ? '' : v })}
              items={[
                { value: 'all', label: 'Все состояния' },
                ...STATUSES.map((s) => ({ value: s.id, label: s.name })),
              ]}
            />
          </label>
          <label htmlFor="contexts-parked" className="contexts-parked">
            <Checkbox
              id="contexts-parked"
              checked={parked}
              onCheckedChange={(v) => update({ parked: !!v })}
            />
            <span>Только вне стола</span>
          </label>
        </div>
        <div className="contexts-list">
          {tasks.length === 0 && (
            <p className="desk-rail-empty">Здесь пока нет задач.</p>
          )}
          {tasks.map((task) => (
            <button
              type="button"
              className="contexts-item"
              key={task.id}
              onClick={() => {
                close();
                onOpenTask(task);
              }}
            >
              <small>
                {data.projects.find((p) => p.id === task.projectId)?.name ??
                  'Без направления'}
              </small>
              <strong>{task.title}</strong>
              <span className="contexts-item-status">
                {task.focusKey !== null
                  ? 'На столе'
                  : STATUSES.find((s) => s.id === visibleStatus(task.status))
                      ?.name}
              </span>
            </button>
          ))}
        </div>
        <div className="dialog-actions">
          <Button variant="ghost" onClick={close}>
            Закрыть
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
