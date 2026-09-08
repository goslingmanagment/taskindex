import {
  AREAS,
  STATUSES,
  type Task,
  type Project,
  type AreaId,
  type Status,
} from './workspace';
export class InputError extends Error {}
export function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new InputError('Неверный формат данных.');
  return v as Record<string, unknown>;
}
function str(v: unknown, max: number, name: string, required = false): string {
  if (typeof v !== 'string' || v.length > max || (required && !v.trim()))
    throw new InputError(`Проверьте поле «${name}».`);
  return v.trim();
}
function date(v: unknown): string {
  const s = str(v, 10, 'Дата');
  if (s) {
    const d = new Date(s + 'T12:00:00Z');
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
      !Number.isFinite(d.getTime()) ||
      d.toISOString().slice(0, 10) !== s
    )
      throw new InputError('Укажите существующую дату.');
  }
  return s;
}
function area(v: unknown): AreaId {
  if (!AREAS.some((a) => a.id === v)) throw new InputError('Выберите область.');
  return v as AreaId;
}
function revision(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    throw new InputError('Неверная версия записи.');
  return v;
}
export function identifier(v: unknown): string {
  const s = str(v, 80, 'Идентификатор', true);
  if (!/^[a-zA-Z0-9_-]+$/.test(s))
    throw new InputError('Неверный идентификатор.');
  return s;
}
export function validateTask(input: unknown): Task {
  const v = object(input);
  if (!STATUSES.some((s) => s.id === v.status))
    throw new InputError('Выберите состояние задачи.');
  if (
    typeof v.rank !== 'number' ||
    !Number.isFinite(v.rank) ||
    Math.abs(v.rank) > 1e12
  )
    throw new InputError('Неверный порядок задачи.');
  if (typeof v.demo !== 'boolean' || typeof v.archived !== 'boolean')
    throw new InputError('Неверное состояние задачи.');
  if (v.focus !== undefined && typeof v.focus !== 'boolean')
    throw new InputError('Неверное состояние фокуса.');
  if (!Array.isArray(v.checklist) || v.checklist.length > 100)
    throw new InputError('В списке может быть до 100 шагов.');
  const checklist = v.checklist.map((c) => {
    const item = object(c);
    if (typeof item.done !== 'boolean')
      throw new InputError('Неверное состояние шага.');
    return {
      id: identifier(item.id),
      text: str(item.text, 500, 'Шаг', true),
      done: item.done,
    };
  });
  if (new Set(checklist.map((c) => c.id)).size !== checklist.length)
    throw new InputError('Шаги должны иметь разные идентификаторы.');
  return {
    id: identifier(v.id),
    area: area(v.area),
    projectId: v.projectId === '' ? '' : identifier(v.projectId),
    title: str(v.title, 240, 'Название', true),
    status: v.status as Status,
    note: str(v.note, 16000, 'Заметка'),
    due: date(v.due),
    waitingFor: str(v.waitingFor, 240, 'Чего ждём'),
    followUp: date(v.followUp),
    checklist,
    rank: v.rank,
    demo: v.demo,
    archived: v.archived,
    ...(v.focus !== undefined ? { focus: v.focus } : {}),
    revision: revision(v.revision),
  };
}
export function validateProject(input: unknown): Project {
  const v = object(input);
  const color = str(v.color, 7, 'Цвет');
  if (!/^#[a-fA-F0-9]{6}$/.test(color)) throw new InputError('Неверный цвет.');
  return {
    id: identifier(v.id),
    area: area(v.area),
    name: str(v.name, 60, 'Название', true),
    color,
    revision: revision(v.revision),
  };
}
