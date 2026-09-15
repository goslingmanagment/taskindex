import type { ReactNode } from 'react';
import { Star, Search } from 'lucide-react';
import type { Task } from '@shared/model';
import { Button } from '../ui/button';
import { Empty, EmptyTitle, EmptyDescription } from '../ui/empty';
import { taskCount } from './labels';

export function WorkspaceOverview({
  searching,
  groups,
  renderTask,
  onBrowse,
}: {
  searching: boolean;
  groups: { id: string; title: string; tasks: Task[] }[];
  renderTask: (task: Task) => ReactNode;
  onBrowse: () => void;
}) {
  const total = groups.reduce((count, group) => count + group.tasks.length, 0);
  if (!total)
    return (
      <Empty className="main-empty">
        <span className="empty-icon">{searching ? <Search /> : <Star />}</span>
        <EmptyTitle>
          {searching ? 'Ничего не нашлось' : 'Что возьмёшь в фокус?'}
        </EmptyTitle>
        <EmptyDescription>
          {searching
            ? 'Поиск проверяет названия, заметки, чеклисты и направления во всех областях. Попробуй другое слово или переключись на архив.'
            : 'В меню нужной карточки выбери «В фокус». Выбранные задачи будут доступны на одном экране.'}
        </EmptyDescription>
        {!searching && (
          <Button variant="outline" onClick={onBrowse}>
            Выбрать задачи
          </Button>
        )}
      </Empty>
    );
  return (
    <div className="workspace-overview" data-large={total > 200 || undefined}>
      {!searching && !groups[0]?.tasks.length && (
        <p className="focus-hint">
          Для своего короткого списка выбери «В фокус» в меню карточки.
        </p>
      )}
      {groups
        .filter((group) => group.tasks.length > 0)
        .map((group) => (
          <section
            className="overview-group"
            key={group.id}
            aria-label={group.title}
          >
            <h2
              aria-label={`${group.title} · ${taskCount(group.tasks.length)}`}
            >
              {group.title}
              <span aria-hidden="true">{group.tasks.length}</span>
            </h2>
            <div className="overview-cards">{group.tasks.map(renderTask)}</div>
          </section>
        ))}
    </div>
  );
}
