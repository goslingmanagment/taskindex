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
