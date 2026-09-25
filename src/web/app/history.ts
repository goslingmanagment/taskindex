import { AREAS, STATUSES } from '@shared/model';
import { PRIORITIES } from '@shared/labels';
import type {
  Agent,
  Changes,
  DomainEvent,
  Label,
  OperationSummary,
  Project,
  Step,
  Task,
} from '@shared/model';
// TI-032: the story of a change, in Russian, built only from the event itself.
// The stored payload is untouched: this is a presentation layer over `changes`,
// and everything it cannot explain from the event stays in the technical
// details instead of being guessed.

type HistoryContext = {
  // Directories used to name a project or label id. They describe today's
  // workspace, not the moment of the event — a project line built from them
  // carries `note`; a label keeps its record in the archive, so its name holds.
  projects: readonly Project[];
  labels: readonly Label[];
  // Name the task a step grew into and the step an event is about (TI-095);
  // optional, like the others a directory of today.
  tasks?: readonly Pick<Task, 'id' | 'title'>[];
  steps?: readonly Pick<Step, 'id' | 'text'>[];
};
type HistoryLine = {
  label: string;
  text: string;
  // A caveat shown next to the line: today's directory was consulted.
  note?: string;
};
type HistoryStory = {
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
  priority: 'Приоритет',
  area: 'Область',
  projectId: 'Направление',
  labels: 'Метки',
  closes: 'Закрывает',
  focus: 'Фокус',
  archived: 'Архив',
  due: 'Срок',
  followUp: 'Дата возврата',
  waitingFor: 'Чего ждём',
  note: 'Заметка',
  description: 'Описание',
  color: 'Цвет',
  checklist: 'Шаги',
  // Fields of a step record (TI-095).
  done: 'Отметка',
  result: 'Итог',
  linkedTaskId: 'Задача',
  removedAt: 'Шаг',
  originUrl: 'Источник',
  deletedAt: 'Удаление',
  archivedAt: 'Архив',
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
  'position',
  'doneAt',
  'doneBy',
  'doneByLabel',
  'originSystem',
  'originRef',
  'originVersion',
]);
// Shown next to a name resolved through today's directory: the event itself
// only stores the id, so the name may have changed since.
const CURRENT_NAMES = 'название на сегодня';

function quote(raw: string): string {
  const text = raw.length > 80 ? `${raw.slice(0, 79)}…` : raw;
  return `«${text}»`;
}
function areaName(id: unknown): string | null {
  return AREAS.find((a) => a.id === id)?.name ?? null;
}
function statusName(id: unknown): string | null {
  return STATUSES.find((s) => s.id === id)?.name ?? null;
}
function day(raw: string): string {
  // A date field is a plain calendar day; read it as UTC so the workspace time
  // zone cannot move it to the previous one.
  const date = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? raw
    : date.toLocaleDateString('ru-RU', {
        timeZone: 'UTC',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
}
type Item = { id: string; text: string; done: boolean };
function items(raw: unknown): Item[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.every(
    (i) =>
      i !== null &&
      typeof i === 'object' &&
      typeof (i as Item).id === 'string' &&
      typeof (i as Item).text === 'string' &&
      typeof (i as Item).done === 'boolean',
  )
    ? (raw as Item[])
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
// Labels are a set; tell which names were added and removed.
function labelsText(from: unknown, to: unknown, ctx: HistoryContext): string {
  const labelName = (id: unknown) =>
    ctx.labels.find((label) => label.id === id)?.name ?? String(id);
  const before = Array.isArray(from) ? from : [],
    after = Array.isArray(to) ? to : [];
  const added = after.filter((id) => !before.includes(id)).map(labelName);
  const removed = before.filter((id) => !after.includes(id)).map(labelName);
  const told = [
    ...added.map((name) => `+${name}`),
    ...removed.map((name) => `−${name}`),
  ];
  if (!told.length)
    return after.length ? after.map(labelName).join(', ') : 'без меток';
  return told.join(', ');
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
  if (field === 'priority') {
    const level = PRIORITIES.find((priority) => priority.id === raw);
    return { text: level ? level.name : 'другой приоритет' };
  }
  if (field === 'closes' && typeof raw === 'string' && raw)
    return { text: `проблема «${raw}»` };
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
const CREATING = new Set([
  'task.create',
  'project.create',
  'label.create',
  'comment.add',
  'checklist.add',
]);
function empty(raw: unknown): boolean {
  return (
    raw === null ||
    raw === undefined ||
    raw === '' ||
    raw === false ||
    (Array.isArray(raw) && raw.length === 0)
  );
}
function line(
  field: string,
  change: { from: unknown; to: unknown },
  ctx: HistoryContext,
  creating = false,
  // The step the event is about, when the directory of today knows it.
  step?: { text: string },
): HistoryLine {
  const label = FIELD_LABELS[field]!;
  const named = (verb: string, prefix = 'Шаг') =>
    step
      ? {
          label,
          text: `${prefix} ${quote(step.text)} ${verb}`,
          note: CURRENT_NAMES,
        }
      : { label, text: `${prefix} ${verb}` };
  if (field === 'labels')
    return {
      label,
      text: labelsText(creating ? [] : change.from, change.to, ctx),
    };
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
  // A step's own fields (TI-095): the tick, the removal and the task it grew
  // into are told as what happened, not as a value that changed.
  if (field === 'done')
    return change.to
      ? named('отмечен выполненным')
      : named('снята отметка', 'С шага');
  if (field === 'removedAt')
    return change.to ? named('убран') : named('возвращён');
  if (field === 'linkedTaskId') {
    if (!change.to) return named('больше не связан с задачей');
    const linked = ctx.tasks?.find((t) => t.id === change.to);
    const told = named(
      linked ? `вынесен в задачу ${quote(linked.title)}` : 'вынесен в задачу',
    );
    return linked ? { ...told, note: CURRENT_NAMES } : told;
  }
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
  if (field === 'archivedAt')
    return {
      label,
      text: change.to ? 'Метка в архиве' : 'Метка возвращена из архива',
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
// An agent proposal (spec 2026-09-25) is told by its outcome and the reason
// given; everything else about it stays in the technical details.
const PROPOSAL_OUTCOMES: Record<string, string> = {
  queued: 'В очереди',
  shown: 'Показано владельцу',
  accepted: 'Принято',
  rejected: 'Отклонено',
  expired: 'Истекло без ответа',
  stale: 'Устарело: задача изменилась',
};
function proposalStory(event: DomainEvent): HistoryStory {
  const status = event.changes.status?.to;
  const reason = event.changes.decisionReason?.to;
  const outcome =
    typeof status === 'string' ? PROPOSAL_OUTCOMES[status] : undefined;
  const lines: HistoryLine[] = [
    { label: 'Предложение', text: outcome ?? 'Изменено' },
  ];
  if (typeof reason === 'string' && reason)
    lines.push({ label: 'Причина', text: quote(reason) });
  return { lines, technical: Object.entries(event.changes) };
}
// A decision on a proposal goes back only whole, with the task write it made
// (spec 2026-09-25, §5.1): the server refuses to undo any event of such an
// operation by seq, the task's event included. `events` is the whole
// operation, the same test the server makes.
export const decidesProposal = (events: readonly DomainEvent[]) =>
  events.length > 1 && events.some((e) => e.entityKind === 'proposal');
export function describeEvent(
  event: DomainEvent,
  ctx: HistoryContext,
): HistoryStory {
  if (event.entityKind === 'proposal') return proposalStory(event);
  const lines: HistoryLine[] = [];
  const technical: HistoryStory['technical'] = [];
  // The task a promotion creates is a creation; the step it links is not.
  const creating =
    CREATING.has(event.command) ||
    (event.command === 'checklist.promote' && event.entityKind === 'task');
  const order = creating ? null : orderLine(event.changes);
  const step =
    event.entityKind === 'step'
      ? ctx.steps?.find((s) => s.id === event.entityId)
      : undefined;
  // A new step is told by its text alone: its open tick and absent link say
  // nothing yet.
  if (creating && event.entityKind === 'step') {
    const text = event.changes.text?.to;
    lines.push({
      label: 'Шаг',
      text:
        typeof text === 'string' ? `Добавлен шаг ${quote(text)}` : 'Добавлен',
    });
    return { lines, technical: Object.entries(event.changes) };
  }
  for (const field of ORDER) {
    const change = event.changes[field];
    if (!change || field === 'orderKey') continue;
    if (creating && empty(change.to)) continue;
    lines.push(line(field, change, ctx, creating, step));
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

// TI-076: the authors the owner can filter by. The directory of agents is the
// primary source; an author that only appears in the loaded journal (an agent
// that was removed, or one from another generation) is kept so old records stay
// selectable instead of disappearing from the filter.
export const ALL_ACTORS = '';
export function actorOptions(
  agents: readonly Agent[] | null,
  // Only the author of each loaded operation matters here.
  operations: readonly Pick<OperationSummary, 'actorId' | 'actorLabel'>[],
): { value: string; label: string }[] {
  const options = new Map<string, string>([
    [ALL_ACTORS, 'Все авторы'],
    ['owner', 'Владелец'],
  ]);
  for (const agent of agents ?? [])
    options.set(
      `agent:${agent.id}`,
      agent.disabledAt ? `${agent.label} (отключён)` : agent.label,
    );
  for (const operation of operations)
    if (!options.has(operation.actorId))
      options.set(operation.actorId, `${operation.actorLabel} (нет в списке)`);
  return [...options].map(([id, label]) => ({ value: id, label }));
}
