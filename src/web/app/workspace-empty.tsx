import {
  Archive,
  CircleCheck,
  EyeOff,
  PanelsTopLeft,
  Plus,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Empty, EmptyTitle, EmptyDescription } from '../ui/empty';
import { useNavigation } from './navigation';
import { taskCount } from './labels';
function emptyContent(archive: boolean, todayOnly: boolean, hiddenP3: number) {
  if (archive)
    return {
      Icon: Archive,
      title: 'Архив пуст',
      description: 'Здесь сохраняются задачи, убранные с доски.',
    };
  if (hiddenP3 > 0)
    return {
      Icon: EyeOff,
      title: 'Задачи скрыты фильтром',
      description: `Скрыто задач P3: ${taskCount(hiddenP3)}.${todayOnly ? ' Также включён фильтр «На сегодня».' : ''}`,
    };
  if (todayOnly)
    return {
      Icon: CircleCheck,
      title: 'На сегодня всё спокойно',
      description: 'Нет задач со сроком или проверкой на сегодня.',
    };
  return {
    Icon: PanelsTopLeft,
    title: 'Здесь пока нет задач',
    description: 'Добавь первое дело. Достаточно названия.',
  };
}
export function WorkspaceEmpty({
  onCreate,
  hiddenP3,
  onShowP3,
  onShowAll,
}: {
  onCreate: () => void;
  hiddenP3: number;
  onShowP3: () => void;
  onShowAll: () => void;
}) {
  const { location } = useNavigation();
  const { archive, today: todayOnly } = location;
  const hidden = hiddenP3 > 0;
  const { Icon, title, description } = emptyContent(
    archive,
    todayOnly,
    hiddenP3,
  );
  return (
    <Empty className="main-empty">
      <span className="empty-icon">
        <Icon />
      </span>
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyDescription>{description}</EmptyDescription>
      {(hidden || todayOnly) && (
        <div className="empty-actions">
          {hidden && (
            <Button variant="outline" onClick={onShowP3}>
              Показать P3
            </Button>
          )}
          {todayOnly && (
            <Button variant="outline" onClick={onShowAll}>
              Показать все задачи
            </Button>
          )}
        </div>
      )}
      {!hidden && !todayOnly && !archive && (
        <Button onClick={onCreate}>
          <Plus />
          Добавить задачу
        </Button>
      )}
    </Empty>
  );
}
