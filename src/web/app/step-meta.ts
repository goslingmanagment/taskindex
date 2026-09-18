import type { ChecklistItem } from '@shared/model';
// The byline of a done step (TI-095): who ticked it and on which day, in the
// workspace time zone. Steps migrated from the rows of 0008 know they are
// done but not by whom: they get no byline.
export function stepByline(
  item: Pick<ChecklistItem, 'done' | 'doneAt' | 'doneByLabel'>,
  timezone: string,
): string | null {
  if (!item.done || !item.doneByLabel) return null;
  const day = item.doneAt
    ? new Date(item.doneAt).toLocaleDateString('ru-RU', {
        timeZone: timezone,
        day: 'numeric',
        month: 'short',
      })
    : '';
  return day ? `${item.doneByLabel} · ${day}` : item.doneByLabel;
}
