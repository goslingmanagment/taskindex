#!/usr/bin/env node
// Утреннее сообщение (спека 2026-09-25-agent-proposals §2 и §5.3): до пяти
// предложений на сегодня текстом для Телеграма или NO_REPLY. Крон OpenClaw
// `proposals-morning:v1` доставляет stdout владельцу.
//
//   node scripts/night-shift/morning.mts
//
// formatMorning чистая, её проверяют золотые тексты в tests/unit; запуск с
// чтением last-run.json и вызовами CLI внизу файла.
import type { Task } from '../../src/shared/model.ts';
import { DEFAULT_TIMEZONE, dayMonth, localDate } from './audit.mts';
import type { Evidence } from './audit.mts';
import { errorMessage, readReport, taskindex } from './io.mts';
import type { RunReport } from './report.mts';

const STALE_REPORT_MS = 26 * 3_600_000;
const OLD_NOTE = 60;
export const SILENCE = 'NO_REPLY';

// A proposal record as the server returns it (plan §1.1); only the fields
// the message needs.
export interface ProposalView {
  id: string;
  kind: 'new_task' | 'task_change';
  taskId: string | null;
  command: { command: string; payload: Record<string, unknown> };
  reason: string;
  evidence: Evidence[];
  number: number | null;
}
// The result of `proposal.deliver` (plan §1.2).
export interface DeliverResult {
  date: string;
  shown: ProposalView[];
  queued: number;
  expired: string[];
  stale: string[];
}
interface Named {
  id: string;
  name: string;
}
// Names for ids, from `taskindex context`: the board's own words.
export interface Catalog {
  areas: readonly Named[];
  statuses: readonly Named[];
  projects: readonly Named[];
  labels: readonly Named[];
}
export type TaskView = Pick<
  Task,
  | 'id'
  | 'title'
  | 'status'
  | 'area'
  | 'projectId'
  | 'priority'
  | 'labels'
  | 'closes'
  | 'note'
  | 'due'
  | 'waitingFor'
  | 'followUp'
>;
export interface MorningInput {
  deliver: DeliverResult | null;
  // Why `deliver` is missing: the CLI call failed.
  deliverError?: string;
  tasksById: ReadonlyMap<string, TaskView>;
  lastRun: RunReport | null;
  now: Date;
  catalog: Catalog;
  timezone?: string;
}

const SOURCES: Record<Evidence['source'], string> = {
  session: 'сессия',
  telegram: 'Телеграм',
  board: 'доска',
};

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const nameOf = (list: readonly Named[], id: string) =>
  list.find((entry) => entry.id === id)?.name ?? id;
const clip = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;
const indent = (block: string) =>
  block
    .split('\n')
    .map((line) => `   ${line}`)
    .join('\n');
const dateOf = (at: string, timezone: string) =>
  dayMonth(at.length > 10 ? localDate(at, timezone) : at);

// The failure line of spec §5.3 p.1: no report, a report older than 26 hours
// or a run that did not finish cleanly.
export function nightShiftFailure(
  lastRun: RunReport | null,
  now: Date,
  timezone = DEFAULT_TIMEZONE,
): string | null {
  if (!lastRun) return 'отчёта прогона нет';
  const finished = Date.parse(lastRun.finishedAt || lastRun.startedAt);
  if (!Number.isFinite(finished))
    return lastRun.errors[0]?.message ?? 'отчёт прогона не читается';
  if (now.getTime() - finished > STALE_REPORT_MS) {
    const at = new Date(finished);
    const time = new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
    }).format(at);
    return `последний прогон ${dayMonth(localDate(at.toISOString(), timezone))} в ${time}`;
  }
  if (lastRun.ok) return null;
  const [first, ...rest] = lastRun.errors;
  if (!first) return 'прогон завершился с ошибкой';
  return rest.length
    ? `${first.message} (и ещё ошибок: ${rest.length})`
    : first.message;
}

// The card of a new task: every field `task.create` fills with something
// other than its default, in the words of fieldChange below. Placement,
// origin and ticked or reported steps never get this far: the proposal check
// refuses them (proposalCommandIssues in src/shared/schemas.ts). The task id
// goes unshown: it names the record and changes nothing the owner gets.
function newTaskLines(
  proposal: ProposalView,
  catalog: Catalog,
  timezone: string,
): string[] {
  const payload = proposal.command.payload;
  const field = (key: string) => text(payload[key]);
  const meta = [nameOf(catalog.areas, field('area'))];
  if (field('projectId'))
    meta.push(nameOf(catalog.projects, field('projectId')));
  meta.push((field('priority') || 'p2').toUpperCase());
  const labels = Array.isArray(payload.labels)
    ? payload.labels.filter((id): id is string => typeof id === 'string')
    : [];
  if (labels.length)
    meta.push(labels.map((id) => nameOf(catalog.labels, id)).join(', '));
  // The queue is where a new task lands anyway.
  if (field('status') && field('status') !== 'todo')
    meta.push(`состояние ${nameOf(catalog.statuses, field('status'))}`);
  if (field('due')) meta.push(`срок ${dayMonth(field('due'))}`);
  if (field('followUp')) meta.push(`вернуться ${dayMonth(field('followUp'))}`);
  if (field('waitingFor')) meta.push(`ждём «${field('waitingFor')}»`);
  if (field('closes')) meta.push(`закрывает ${field('closes')}`);
  const lines = [
    `${proposal.number}. ${field('title')}`,
    indent(meta.join(' · ')),
  ];
  if (field('note').trim()) lines.push(indent(field('note').trim()));
  // A step marked removed is not created.
  const steps = (Array.isArray(payload.checklist) ? payload.checklist : [])
    .map((step) => step as { text?: unknown; removed?: unknown })
    .filter((step) => step.removed !== true)
    .map((step) => `– ${text(step.text).split('\n').join('\n  ')}`);
  if (steps.length) lines.push(indent(['Шаги:', ...steps].join('\n')));
  if (proposal.evidence.length)
    lines.push(
      indent(
        `Откуда: ${proposal.evidence
          .map(
            (item) =>
              `${SOURCES[item.source] ?? item.source}, ${dateOf(item.at, timezone)}: «${item.quote}»`,
          )
          .join('; ')}`,
      ),
    );
  return lines;
}

const quotedOr = (value: string, empty: string) =>
  value ? `«${value}»` : empty;

// One changed field as «поле было → станет», in the board's words.
function fieldChange(
  field: string,
  before: unknown,
  after: unknown,
  catalog: Catalog,
): string | null {
  const day = (value: unknown, empty: string) =>
    text(value) ? dayMonth(text(value)) : empty;
  const list = (value: unknown) =>
    Array.isArray(value)
      ? value
          .filter((id): id is string => typeof id === 'string')
          .map((id) => nameOf(catalog.labels, id))
          .join(', ')
      : '';
  switch (field) {
    case 'title':
      return `название «${text(before)}» → «${text(after)}»`;
    case 'note':
      return text(before)
        ? `заметка «${clip(text(before), OLD_NOTE)}» → ${quotedOr(text(after), 'пустая')}`
        : `заметка пустая → ${quotedOr(text(after), 'пустая')}`;
    case 'due':
      return `срок ${day(before, 'не задан')} → ${day(after, 'без срока')}`;
    case 'followUp':
      return `вернуться ${day(before, 'не задано')} → ${day(after, 'не задано')}`;
    case 'priority':
      return `приоритет ${text(before).toUpperCase()} → ${text(after).toUpperCase()}`;
    case 'area':
      return `область ${nameOf(catalog.areas, text(before))} → ${nameOf(catalog.areas, text(after))}`;
    case 'projectId':
      return `направление ${text(before) ? nameOf(catalog.projects, text(before)) : 'нет'} → ${
        text(after) ? nameOf(catalog.projects, text(after)) : 'нет'
      }`;
    case 'labels':
      return `метки ${list(before) || 'нет'} → ${list(after) || 'нет'}`;
    case 'waitingFor':
      return `ждём ${quotedOr(text(before), 'ничего')} → ${quotedOr(text(after), 'ничего')}`;
    case 'closes':
      return `закрывает ${text(before) || 'ничего'} → ${text(after) || 'ничего'}`;
    default:
      return null;
  }
}

function changeText(
  proposal: ProposalView,
  task: TaskView | undefined,
  catalog: Catalog,
): string {
  const { command, payload } = proposal.command;
  if (command === 'task.archive') return 'в архив';
  if (command === 'task.move') {
    const target = nameOf(catalog.statuses, String(payload.status));
    return task
      ? `${nameOf(catalog.statuses, task.status)} → ${target}`
      : `→ ${target}`;
  }
  const changes: string[] = [];
  for (const [field, value] of Object.entries(payload)) {
    if (field === 'id' || field === 'baseRevision') continue;
    const before = task ? (task as Record<string, unknown>)[field] : undefined;
    const change = fieldChange(field, before, value, catalog);
    if (change) changes.push(change);
  }
  return changes.join('; ') || command;
}

function taskChangeLines(
  proposal: ProposalView,
  tasksById: ReadonlyMap<string, TaskView>,
  catalog: Catalog,
): string[] {
  const task = proposal.taskId ? tasksById.get(proposal.taskId) : undefined;
  const title = task ? `«${task.title}»` : `Задача ${proposal.taskId ?? '?'}`;
  return [
    `${proposal.number}. ${title}: ${changeText(proposal, task, catalog)}`,
    indent(`Почему: ${proposal.reason}`),
  ];
}

export function formatMorning(input: MorningInput): string {
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const blocks: string[] = [];
  const failure = nightShiftFailure(input.lastRun, input.now, timezone);
  const head: string[] = [];
  if (failure) head.push(`Ночная смена не отработала: ${failure}`);
  if (input.deliverError)
    head.push(`Предложения не получены: ${input.deliverError}`);
  if (head.length) blocks.push(head.join('\n'));
  const shown = (input.deliver?.shown ?? []).toSorted(
    (a, b) => (a.number ?? 0) - (b.number ?? 0),
  );
  if (input.deliver && shown.length) {
    blocks.push(
      `Предложения на ${dayMonth(input.deliver.date)} · ${shown.length} из ${
        shown.length + input.deliver.queued
      }`,
    );
    const created = shown.filter((proposal) => proposal.kind === 'new_task');
    const changes = shown.filter((proposal) => proposal.kind === 'task_change');
    if (created.length)
      blocks.push(
        [
          'Новые задачи',
          ...created.flatMap((proposal) =>
            newTaskLines(proposal, input.catalog, timezone),
          ),
        ].join('\n'),
      );
    if (changes.length)
      blocks.push(
        [
          'По доске',
          ...changes.flatMap((proposal) =>
            taskChangeLines(proposal, input.tasksById, input.catalog),
          ),
        ].join('\n'),
      );
  }
  return blocks.length ? blocks.join('\n\n') : SILENCE;
}

// `proposal.deliver` answers with the operation; the deliver fields sit in
// the first command result, or in its record (plan §1.2 names the fields,
// not the nesting).
export function deliverResultOf(reply: unknown): DeliverResult | null {
  const body = reply as Record<string, unknown> | undefined;
  const first = (Array.isArray(body?.results) ? body.results[0] : undefined) as
    | Record<string, unknown>
    | undefined;
  for (const candidate of [first, first?.record, first?.result, body]) {
    const value = candidate as Partial<DeliverResult> | undefined;
    if (
      value &&
      typeof value.date === 'string' &&
      Array.isArray(value.shown) &&
      typeof value.queued === 'number'
    )
      return {
        date: value.date,
        shown: value.shown,
        queued: value.queued,
        expired: value.expired ?? [],
        stale: value.stale ?? [],
      };
  }
  return null;
}

async function main(): Promise<string> {
  const lastRun = await readReport();
  const catalog: Catalog = {
    areas: [],
    statuses: [],
    projects: [],
    labels: [],
  };
  const tasksById = new Map<string, TaskView>();
  let deliver: DeliverResult | null = null;
  let deliverError: string | undefined;
  let timezone = DEFAULT_TIMEZONE;
  try {
    const [reply] = await taskindex(['proposal', 'deliver', '--limit', '5']);
    deliver = deliverResultOf(reply);
    if (!deliver) deliverError = 'ответ deliver без списка предложений';
  } catch (error) {
    deliverError = errorMessage(error);
  }
  if (deliver?.shown.length) {
    // Names only: without the context the lines carry ids, still exact.
    const [context] = await taskindex(['context']).catch(() => []);
    const read = (key: keyof Catalog) =>
      Array.isArray(context?.[key]) ? (context[key] as Named[]) : [];
    catalog.areas = read('areas');
    catalog.statuses = read('statuses');
    catalog.projects = read('projects');
    catalog.labels = read('labels');
    if (typeof context?.timezone === 'string') timezone = context.timezone;
    for (const proposal of deliver.shown) {
      if (proposal.kind !== 'task_change' || !proposal.taskId) continue;
      try {
        const [task] = await taskindex(['task', 'get', proposal.taskId]);
        if (task) tasksById.set(proposal.taskId, task as unknown as TaskView);
      } catch {
        // The line falls back to the task id; the proposal still shows.
      }
    }
  }
  return formatMorning({
    deliver,
    deliverError,
    tasksById,
    lastRun,
    now: new Date(),
    catalog,
    timezone,
  });
}

if (import.meta.main) {
  if (process.argv.includes('--help'))
    process.stdout.write(
      'node scripts/night-shift/morning.mts: текст утреннего сообщения или NO_REPLY\n',
    );
  else {
    // The owner gets a line even when the script itself breaks: the cron
    // delivers stdout, and silence would hide the failure.
    let message: string;
    try {
      message = await main();
    } catch (error) {
      message = `Утренние предложения не собраны: ${errorMessage(error)}`;
    }
    process.stdout.write(`${message}\n`);
  }
}
