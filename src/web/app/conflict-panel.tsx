import type { ReactNode } from 'react';
import { Button } from '../ui/button';
// TI-059 (план 07, шаг 14): панель «версии разошлись» одна на карточку задачи и
// на диалог направления. Отличается только представление актуальной записи:
// у задачи это `details` с JSON, у направления — список полей.
export function ConflictPanel({
  summary,
  note,
  onMerge,
  className = '',
}: {
  /** Актуальная версия в том виде, в каком её показывает форма. */
  summary: ReactNode;
  note: string;
  onMerge: () => void;
  className?: string;
}) {
  return (
    <div className={`conflict-box ${className}`.trim()}>
      {summary}
      <p>{note}</p>
      <Button type="button" variant="outline" onClick={onMerge}>
        Совместить и проверить
      </Button>
    </div>
  );
}
