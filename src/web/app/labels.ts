// Russian names of commands as shown in history, activity and pending notices.
export const commandLabels: Record<string, string> = {
  'task.create': 'Создана задача',
  'task.sync': 'Обновлено из источника',
  'task.update': 'Изменена задача',
  'task.save': 'Сохранена карточка',
  'task.move': 'Задача перемещена',
  'task.archive': 'Задача в архиве',
  'task.restore': 'Задача возвращена',
  'project.create': 'Создано направление',
  'project.update': 'Изменено направление',
  'label.create': 'Создана метка',
  'label.update': 'Изменена метка',
  'label.archive': 'Метка в архиве',
  'label.restore': 'Метка возвращена',
  'comment.add': 'Добавлен комментарий',
  'comment.remove': 'Удалён комментарий',
  undo: 'Отменено изменение',
  batch: 'Пакет изменений',
  'checklist.add': 'Добавлен шаг',
  'checklist.update': 'Изменён шаг',
  'checklist.remove': 'Удалён шаг',
  'checklist.move': 'Переставлен шаг',
  'checklist.reorder': 'Переставлены шаги',
  'checklist.promote': 'Шаг вынесен в задачу',
  'appearance.update': 'Изменено оформление',
  'proposal.create': 'Предложение в очереди',
  'proposal.deliver': 'Предложения показаны',
  'proposal.accept': 'Принято предложение',
  'proposal.reject': 'Отклонено предложение',
};
// The night shift's bookkeeping (spec 2026-09-25, §5.1): creating, showing
// and expiring proposals stay out of the owner's «Активность»; an accepted
// proposal is visible there as the task write it made.
export const HIDDEN_ACTIVITY_COMMANDS: ReadonlySet<string> = new Set([
  'proposal.create',
  'proposal.deliver',
]);
export const commandLabel = (command: string) =>
  commandLabels[command] || command;

// TI-031: the single Russian form for a number of tasks («1 задача», «3 задачи»,
// «5 задач»). Input is a non-negative integer (a list length); sources must not
// hand over fractions or NaN — this is not a general-purpose declension helper.
const taskForms = new Intl.PluralRules('ru-RU');
export function taskCount(count: number): string {
  const form = taskForms.select(count);
  return `${count} ${form === 'one' ? 'задача' : form === 'few' ? 'задачи' : 'задач'}`;
}
