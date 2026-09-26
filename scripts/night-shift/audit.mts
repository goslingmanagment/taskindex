// Stage 3 of the night shift (spec 2026-09-25-agent-proposals §5.2): the
// board check without a model. Pure functions only: the runner (run.mts)
// reads the snapshot and the event feed through the CLI and hands them here;
// tests call them with fixtures.
//
// Node runs this file directly (type stripping), so only erasable syntax and
// `import type` from the application sources: a runtime import of `src/**`
// would not resolve its `.js` specifiers without a bundler.
import type { DomainEvent, Step, Task } from '../../src/shared/model.ts';

export const DEFAULT_TIMEZONE = 'Europe/Moscow';
const STALE_DAYS = 14;
const POSTPONE_DAYS = 7;
const QUOTE_TITLE = 120;
const DAY_MS = 86_400_000;

export type ProposalRank = 1 | 2 | 3;
export interface Evidence {
  source: 'session' | 'telegram' | 'board';
  ref: string;
  at: string;
  quote: string;
}
export type TaskChangeCommand =
  | { command: 'task.archive'; payload: { id: string; baseRevision: number } }
  | {
      command: 'task.update';
      payload: { id: string; baseRevision: number; due: string };
    };
// The payload of `proposal.create` for a change of an existing task (plan
// 2026-09-25-proposals-phase1 §1.1).
export interface ProposalDraft {
  kind: 'task_change';
  taskId: string;
  baseRevision: number;
  command: TaskChangeCommand;
  reason: string;
  evidence: [Evidence];
  fingerprint: string;
  rank: ProposalRank;
}
export interface LastEvent {
  seq: number;
  at: string;
}
export interface AuditInput {
  tasks: readonly Task[];
  // The latest journal event of each task (collectLastEvents), never
  // `updatedAt`: migrations and the agent rename moved it without events.
  lastEventAt: ReadonlyMap<string, LastEvent>;
  // Today in the owner's timezone, YYYY-MM-DD.
  today: string;
  timezone?: string;
}

// The latest event per task: events of the task itself and of its steps. A
// step event names its task in `taskId`; older rows without it are matched
// through the step records (removed ones included) and the live checklist.
export function collectLastEvents(input: {
  tasks: readonly Pick<Task, 'id' | 'checklist'>[];
  steps: readonly Pick<Step, 'id' | 'taskId'>[];
  events: readonly Pick<
    DomainEvent,
    'seq' | 'at' | 'entityKind' | 'entityId' | 'taskId'
  >[];
}): Map<string, LastEvent> {
  const stepTask = new Map<string, string>();
  for (const step of input.steps) stepTask.set(step.id, step.taskId);
  for (const task of input.tasks)
    for (const item of task.checklist) stepTask.set(item.id, task.id);
  const taskOf = (event: (typeof input.events)[number]) => {
    if (event.entityKind === 'task') return event.entityId;
    if (event.entityKind === 'step')
      return event.taskId ?? stepTask.get(event.entityId);
    return undefined;
  };
  const last = new Map<string, LastEvent>();
  for (const event of input.events) {
    const taskId = taskOf(event);
    if (!taskId) continue;
    const known = last.get(taskId);
    if (!known || event.seq > known.seq)
      last.set(taskId, { seq: event.seq, at: event.at });
  }
  return last;
}

export function localDate(instant: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}

const toUtc = (date: string) => Date.parse(`${date}T00:00:00Z`);
export const addDays = (date: string, days: number) =>
  new Date(toUtc(date) + days * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) =>
  Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
export const dayMonth = (date: string) =>
  `${date.slice(8, 10)}.${date.slice(5, 7)}`;

// 1 день, 2 дня, 5 дней, 11 дней, 21 день.
export function daysWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (ones === 1 && tens !== 11) return 'день';
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return 'дня';
  return 'дней';
}

function validDate(year: number, month: number, day: number): string | null {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  )
    return null;
  return value.toISOString().slice(0, 10);
}

// `ДД.ММ` (optionally `.ГГГГ` or `.ГГ`) in a title. Without a year the date
// is the occurrence nearest to the day the task was created: a task made on
// 20.12 about «05.01» means January of the next year.
export function titleDates(title: string, createdOn: string): string[] {
  const dates: string[] = [];
  const pattern = /(?<![\d.,])(\d{2})\.(\d{2})(?:\.(\d{4}|\d{2}))?(?![.,]?\d)/g;
  for (const match of title.matchAll(pattern)) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = match[3];
    if (year) {
      const full = year.length === 2 ? 2000 + Number(year) : Number(year);
      const date = validDate(full, month, day);
      if (date) dates.push(date);
      continue;
    }
    const base = Number(createdOn.slice(0, 4));
    let best: string | null = null;
    for (const candidate of [base - 1, base, base + 1]) {
      const date = validDate(candidate, month, day);
      if (!date) continue;
      const distance = Math.abs(daysBetween(createdOn, date));
      if (!best || distance <= Math.abs(daysBetween(createdOn, best)))
        best = date;
    }
    if (best) dates.push(best);
  }
  return dates;
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
const quoted = (task: Task) => `«${clip(task.title, QUOTE_TITLE)}»`;

function draft(
  task: Task,
  command: TaskChangeCommand,
  fields: Pick<ProposalDraft, 'reason' | 'fingerprint' | 'rank'> & {
    at: string;
    quote: string;
  },
): ProposalDraft {
  return {
    kind: 'task_change',
    taskId: task.id,
    baseRevision: task.revision,
    command,
    reason: fields.reason,
    evidence: [
      {
        source: 'board',
        ref: `task:${task.id}`,
        at: fields.at,
        quote: fields.quote,
      },
    ],
    fingerprint: fields.fingerprint,
    rank: fields.rank,
  };
}

// The date a title names: with a due date only a title date equal to it
// counts; without one the latest date of the title.
function titleDate(task: Task, timezone: string): string | null {
  const dates = titleDates(task.title, localDate(task.createdAt, timezone));
  if (task.due) {
    const due = task.due;
    return dates.some((date) => date.slice(5) === due.slice(5)) ? due : null;
  }
  return dates.toSorted().at(-1) ?? null;
}

function datedDraft(task: Task, date: string | null, today: string) {
  if (!date || date >= today) return null;
  const days = daysBetween(date, today);
  return draft(
    task,
    {
      command: 'task.archive',
      payload: { id: task.id, baseRevision: task.revision },
    },
    {
      reason: `дата в названии прошла ${days} ${daysWord(days)} назад`,
      fingerprint: `audit:dated:${task.id}:${task.due ?? 'none'}:${task.revision}`,
      rank: 3,
      at: date,
      quote: `${quoted(task)}, ${task.due ? `срок ${dayMonth(task.due)}` : 'срока нет'}`,
    },
  );
}

function overdueDraft(task: Task, today: string) {
  if (!task.due || task.due >= today) return null;
  return draft(
    task,
    {
      command: 'task.update',
      payload: {
        id: task.id,
        baseRevision: task.revision,
        due: addDays(today, POSTPONE_DAYS),
      },
    },
    {
      reason: `срок прошёл ${dayMonth(task.due)}`,
      fingerprint: `audit:overdue:${task.id}:${task.due}:${task.revision}`,
      rank: 2,
      at: task.due,
      quote: `${quoted(task)}, срок ${dayMonth(task.due)}`,
    },
  );
}

function staleDraft(
  task: Task,
  last: LastEvent | undefined,
  today: string,
  timezone: string,
) {
  if (task.status !== 'todo' || task.priority === 'p3' || task.due) return null;
  // A date still ahead in the title works as a due date: «Визит 15.10» is
  // waiting for its day, not abandoned.
  if (titleDate(task, timezone)) return null;
  // A task without a single event in the feed has no seq to fingerprint;
  // it is left alone rather than judged by `updatedAt`.
  if (!last) return null;
  const days = daysBetween(localDate(last.at, timezone), today);
  if (days < STALE_DAYS) return null;
  return draft(
    task,
    {
      command: 'task.archive',
      payload: { id: task.id, baseRevision: task.revision },
    },
    {
      reason: `${days} ${daysWord(days)} без движения`,
      fingerprint: `audit:stale:${task.id}:${last.seq}`,
      rank: 3,
      at: last.at,
      quote: `${quoted(task)}, последнее событие ${dayMonth(localDate(last.at, timezone))}`,
    },
  );
}

// One draft per open task, the first matching rule wins: a passed date in
// the title, then a passed due date, then two weeks without events. Archived
// and done tasks are never proposed; P3 is spared only by the idle rule.
export function auditBoard(input: AuditInput): ProposalDraft[] {
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const drafts: ProposalDraft[] = [];
  for (const task of input.tasks) {
    if (task.archived || task.status === 'done') continue;
    const found =
      datedDraft(task, titleDate(task, timezone), input.today) ??
      overdueDraft(task, input.today) ??
      staleDraft(task, input.lastEventAt.get(task.id), input.today, timezone);
    if (found) drafts.push(found);
  }
  // Urgent first, then the oldest evidence: when the queue cap cuts the list,
  // the longest-standing items get in.
  return drafts.toSorted(
    (a, b) =>
      a.rank - b.rank ||
      a.evidence[0].at.localeCompare(b.evidence[0].at) ||
      a.taskId.localeCompare(b.taskId),
  );
}
