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
  'comment.add': 'Добавлен комментарий',
  'comment.remove': 'Удалён комментарий',
  undo: 'Отменено изменение',
  batch: 'Пакет изменений',
  'checklist.add': 'Добавлен шаг',
  'checklist.update': 'Изменён шаг',
  'checklist.remove': 'Удалён шаг',
  'checklist.reorder': 'Переставлены шаги',
};
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
