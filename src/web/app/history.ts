import { AREAS, STATUSES } from '@shared/model';
import type { Changes, DomainEvent, Project } from '@shared/model';
// TI-032: the story of a change, in Russian, built only from the event itself.
// The stored payload is untouched: this is a presentation layer over `changes`,
// and everything it cannot explain from the event stays in the technical
// details instead of being guessed.

export type HistoryContext = {
  // Directory used to name a project id. It describes today's workspace, not
  // the moment of the event — every line built from it carries `note`.
  projects: readonly Project[];
};
export type HistoryLine = {
  label: string;
  text: string;
  // A caveat shown next to the line: today's directory was consulted.
  note?: string;
};
export type HistoryStory = {
  lines: HistoryLine[];
  // Everything the story does not cover: bookkeeping fields and any field this
  // build does not know about. Shown collapsed, verbatim.
  technical: [string, { from: unknown; to: unknown }][];
};

// Subject fields, in reading order; `orderKey` is described by the event, not
// by its value, so it is handled separately.
const FIELD_LABELS: Record<string, string> = {
  title: 'Название',
  name: 'Название',
  text: 'Текст',
  status: 'Состояние',
  area: 'Область',
  projectId: 'Направление',
  focus: 'Фокус',
  archived: 'Архив',
  due: 'Срок',
  followUp: 'Дата возврата',
  waitingFor: 'Чего ждём',
  note: 'Заметка',
  description: 'Описание',
  color: 'Цвет',
  checklist: 'Шаги',
  originUrl: 'Источник',
  deletedAt: 'Удаление',
  orderKey: 'Порядок',
};
const ORDER = Object.keys(FIELD_LABELS);
// Bookkeeping the story never tells: it changes on every command and says
// nothing about the owner's intent. Anything outside both lists is a field
// this build does not know — it gets an honest line and the raw values.
const TECHNICAL_FIELDS = new Set([
  'id',
  'taskId',
  'revision',
  'createdAt',
  'updatedAt',
  'createdBy',
  'createdByLabel',
  'actorId',
  'actorLabel',
  'ownerTouchedAt',
  'ownerFields',
  'commentCount',
  'originSystem',
  'originRef',
  'originVersion',
]);
// Shown next to a name resolved through today's directory: the event itself
// only stores the id, so the name may have changed since.
const CURRENT_NAMES = 'название на сегодня';

function quote(value: string): string {
  const text = value.length > 80 ? `${value.slice(0, 79)}…` : value;
  return `«${text}»`;
}
function areaName(id: unknown): string | null {
  return AREAS.find((a) => a.id === id)?.name ?? null;
}
function statusName(id: unknown): string | null {
  return STATUSES.find((s) => s.id === id)?.name ?? null;
}
function day(value: string): string {
  // A date field is a plain calendar day; read it as UTC so the workspace time
  // zone cannot move it to the previous one.
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString('ru-RU', {
        timeZone: 'UTC',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
}
type Item = { id: string; text: string; done: boolean };
function items(value: unknown): Item[] | null {
  if (!Array.isArray(value)) return null;
  return value.every(
    (i) =>
      i !== null &&
      typeof i === 'object' &&
      typeof (i as Item).id === 'string' &&
      typeof (i as Item).text === 'string' &&
      typeof (i as Item).done === 'boolean',
  )
    ? (value as Item[])
    : null;
}
// Checklist steps are matched by their id, never by their position, so a step
// that only moved is never reported as an edit.
function checklistText(from: unknown, to: unknown): string {
  const before = items(from),
    after = items(to);
  if (!before || !after) return 'Шаги изменены';
  const previous = new Map(before.map((i) => [i.id, i]));
  const told: string[] = [];
  for (const item of after) {
    const prior = previous.get(item.id);
    if (!prior) {
      told.push(`добавлен шаг ${quote(item.text)}`);
      continue;
    }
    if (prior.text !== item.text)
      told.push(`шаг ${quote(prior.text)} переименован в ${quote(item.text)}`);
    if (prior.done !== item.done)
      told.push(
        item.done
          ? `шаг ${quote(item.text)} отмечен выполненным`
          : `с шага ${quote(item.text)} снята отметка`,
      );
  }
  const kept = new Set(after.map((i) => i.id));
  for (const item of before)
    if (!kept.has(item.id)) told.push(`удалён шаг ${quote(item.text)}`);
  const commonBefore = before.filter((i) => kept.has(i.id)).map((i) => i.id);
  const commonAfter = after.filter((i) => previous.has(i.id)).map((i) => i.id);
  if (commonBefore.join(',') !== commonAfter.join(','))
    told.push('порядок шагов изменён');
  if (!told.length) return 'Шаги изменены';
  return `${told[0]!.charAt(0).toUpperCase()}${told[0]!.slice(1)}${
    told.length > 1 ? `; ${told.slice(1).join('; ')}` : ''
  }`;
}
function value(
  field: string,
  raw: unknown,
  ctx: HistoryContext,
): { text: string; note?: string } {
  if (field === 'area')
    return { text: areaName(raw) ? quote(areaName(raw)!) : 'другая область' };
  if (field === 'status')
    return {
      text: statusName(raw) ? quote(statusName(raw)!) : 'другое состояние',
    };
  if (field === 'projectId') {
    if (raw === null || raw === undefined) return { text: 'без направления' };
    const project = ctx.projects.find((p) => p.id === raw);
    return project
      ? { text: quote(project.name), note: CURRENT_NAMES }
      : { text: 'направление, которого больше нет' };
  }
  if (raw === null || raw === undefined) return { text: 'не задано' };
  if (raw === true) return { text: 'да' };
  if (raw === false) return { text: 'нет' };
  if (typeof raw === 'string') {
    if (!raw) return { text: 'пусто' };
    return field === 'due' || field === 'followUp'
      ? { text: day(raw) }
      : { text: quote(raw) };
  }
  if (typeof raw === 'number') return { text: String(raw) };
  return { text: 'изменено' };
}
// A creation has no previous state: every field would read «не задано → …».
// Such an event is told as the values it started with, empty ones omitted.
const CREATING = new Set(['task.create', 'project.create', 'comment.add']);
function empty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    value === false ||
    (Array.isArray(value) && value.length === 0)
  );
}
function line(
  field: string,
  change: { from: unknown; to: unknown },
  ctx: HistoryContext,
  creating = false,
): HistoryLine {
  const label = FIELD_LABELS[field]!;
  if (creating) {
    const shown = value(field, change.to, ctx);
    return {
      label,
      text: shown.text,
      ...(shown.note ? { note: shown.note } : {}),
    };
  }
  if (field === 'checklist')
    return { label, text: checklistText(change.from, change.to) };
  if (field === 'focus')
    return { label, text: change.to ? 'Задача в фокусе' : 'Убрана из фокуса' };
  if (field === 'archived')
    return {
      label,
      text: change.to ? 'Задача в архиве' : 'Задача возвращена из архива',
    };
  if (field === 'deletedAt')
    return {
      label,
      text: change.to ? 'Запись удалена' : 'Запись восстановлена',
    };
  const from = value(field, change.from, ctx),
    to = value(field, change.to, ctx);
  return {
    label,
    text: `${from.text} → ${to.text}`,
    ...(from.note || to.note ? { note: from.note ?? to.note } : {}),
  };
}
// Ordering is a fractional key: it says that the task moved, never where to.
// The column is named only when the event itself carries the new status.
function orderLine(changes: Changes): HistoryLine | null {
  if (!('orderKey' in changes)) return null;
  if ('status' in changes || 'area' in changes) return null;
  return { label: FIELD_LABELS.orderKey!, text: 'Изменён порядок' };
}
export function describeEvent(
  event: DomainEvent,
  ctx: HistoryContext,
): HistoryStory {
  const lines: HistoryLine[] = [];
  const technical: HistoryStory['technical'] = [];
  const creating = CREATING.has(event.command);
  const order = creating ? null : orderLine(event.changes);
  for (const field of ORDER) {
    const change = event.changes[field];
    if (!change || field === 'orderKey') continue;
    if (creating && empty(change.to)) continue;
    lines.push(line(field, change, ctx, creating));
  }
  if (order) lines.push(order);
  for (const [field, change] of Object.entries(event.changes)) {
    if (field in FIELD_LABELS) continue;
    technical.push([field, change]);
    // A field from a newer server, or an older event: say that it changed
    // rather than print its JSON as if it were a sentence.
    if (!TECHNICAL_FIELDS.has(field))
      lines.push({ label: `Поле «${field}»`, text: 'изменено' });
  }
  if (!lines.length && event.command === 'task.create')
    lines.push({ label: 'Задача', text: 'Создана' });
  return { lines, technical };
}
