import { Archive, CircleCheck, PanelsTopLeft, Plus } from 'lucide-react';
import { Button } from '../ui/button';
import { Empty, EmptyTitle, EmptyDescription } from '../ui/empty';
import { useNavigation } from './navigation';
// TI-059 (план 07, шаг 12): пустые состояния доски. Три варианта одного экрана:
// архив, фильтр «На сегодня» и пустая область.
export function WorkspaceEmpty({ onCreate }: { onCreate: () => void }) {
  const { location, update } = useNavigation();
  const { archive, today: todayOnly } = location;
  return (
    <Empty className="main-empty">
      <span className="empty-icon">
        {archive ? (
          <Archive />
        ) : todayOnly ? (
          <CircleCheck />
        ) : (
          <PanelsTopLeft />
        )}
      </span>
      <EmptyTitle>
        {archive
          ? 'Архив пуст'
          : todayOnly
            ? 'На сегодня всё спокойно'
            : 'Здесь пока нет задач'}
      </EmptyTitle>
      <EmptyDescription>
        {archive
          ? 'Здесь сохраняются задачи, убранные с доски.'
          : todayOnly
            ? 'Нет задач со сроком или проверкой на сегодня.'
            : 'Добавь первое дело. Достаточно названия.'}
      </EmptyDescription>
      {todayOnly ? (
        <Button
          variant="outline"
          onClick={() => update({ today: false }, true)}
        >
          Показать все задачи
        </Button>
      ) : (
        !archive && (
          <Button onClick={onCreate}>
            <Plus />
            Добавить задачу
          </Button>
        )
      )}
    </Empty>
  );
}
