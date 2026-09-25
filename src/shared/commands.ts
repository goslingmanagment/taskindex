import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { z } from 'zod';
import type {
  Actor,
  Changes,
  Command,
  CommandName,
  CommandOf,
  CommandResult,
  DomainEvent,
  Entity,
  EntityKind,
  WorkspaceState,
  Task,
  Project,
  Comment,
  Appearance,
  Label,
  Step,
  Proposal,
} from './model.js';
import { byFocusKey, byOrder, todayInTimezone } from './queries.js';
import {
  legacyChecklistItems,
  legacySteps,
  liveSteps,
  projectChecklist,
  stepKeyAt,
} from './steps.js';
import {
  commandPayloadSchemas,
  PROPOSAL_COMMANDS,
  proposalCommandIssues,
  type FocusPosition,
} from './schemas.js';
import { assertNever, fail, formatIssuePath } from './errors.js';
import { LIMITS } from './limits.js';
import { DEFAULT_APPEARANCE_ID } from './appearance.js';
import { ENTITIES, STEP_EXECUTION_FIELDS } from './entities.js';
import { DEFAULT_PRIORITY } from './labels.js';
import { uniqueSlug } from './slug.js';
import {
  addDays,
  byQueue,
  closedMessage,
  findProposal,
  staleReason,
} from './proposals.js';
type ChangeEffect = {
  entityKind: EntityKind;
  entityId: string;
  taskId?: string;
  command: CommandName;
  changes: Changes;
  recordRevision: number;
};
// The three selections the reducer makes over the journal: what changed on a
// record after a base revision (merge), the events of one operation and one
// event by position (undo). The server answers them with indexed queries
// (plan 01, step 2); tests and the web client keep passing a plain array.
export type HistoryAccess = {
  forRecord(kind: EntityKind, id: string, afterRevision: number): DomainEvent[];
  forOperation(operationId: string): DomainEvent[];
  bySeq(seq: number): DomainEvent | undefined;
};
function arrayHistory(events: DomainEvent[]): HistoryAccess {
  return {
    forRecord: (kind, id, afterRevision) =>
      events.filter(
        (e) =>
          e.entityKind === kind &&
          e.entityId === id &&
          e.recordRevision > afterRevision,
      ),
    forOperation: (operationId) =>
      events.filter((e) => e.operationId === operationId),
    bySeq: (seq) => events.find((e) => e.seq === seq),
  };
}
type CommandContext = {
  now: string;
  ids: () => string;
  actor: Actor;
  history?: DomainEvent[] | HistoryAccess;
  operationId?: string;
  // Envelope flag: the agent acknowledges it is changing owner decisions.
  confirmOwnerFields?: boolean;
  // The workspace time zone (settings.timezone): proposal.deliver counts the
  // owner's «today» in it.
  timezone?: string;
};
// Owner-only fields: agents cannot set them directly; task.sync skips them.
const ownerOnlyFields = ['focus', 'focusPosition'] as const;
// Fields the source never overwrites once the owner touched the task.
const ownerLockedFields = [
  'status',
  'archived',
  'focus',
  'projectId',
  'area',
  'priority',
];
type CommandApplication = {
  state: WorkspaceState;
  result: CommandResult;
  effects: ChangeEffect[];
};
// The record kinds, their collections and their subject fields come from the
// shared registry (Ж11). `taskFields` stays exported for the independent
// oracle in tests/property/undo.test.ts.
/** @internal for tests */
export const taskFields = ENTITIES.task.subjectFields;
/** @internal for tests */
export function isSubjectField(kind: EntityKind, key: string): boolean {
  return ENTITIES[kind].subjectFields.has(key);
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
// Labels a write may store: every id names a label of the catalogue that is
// not archived, and the set is kept in catalogue order (position), because
// order is not part of a label set.
function writtenLabels(
  state: WorkspaceState,
  labels: readonly string[] = [],
): string[] {
  const catalogue = new Map(state.labels.map((l) => [l.id, l]));
  for (const id of labels) {
    const label = catalogue.get(id);
    if (!label) fail('invalid', `Метки «${id}» нет в каталоге.`);
    if (label.archivedAt) fail('invalid', `Метка «${label.name}» в архиве.`);
  }
  return labels.toSorted(
    (a, b) => catalogue.get(a)!.position - catalogue.get(b)!.position,
  );
}
// Records are told apart by shape: only tasks carry a checklist, only
// comments a deletion instant, only labels an archive instant, only steps a
// removal instant; tasks and steps carry the owner's protected fields.
const isTask = (record: Entity): record is Task => 'checklist' in record;
const isComment = (record: Entity): record is Comment => 'deletedAt' in record;
const isLabel = (record: Entity): record is Label => 'archivedAt' in record;
const isStep = (record: Entity): record is Step => 'removedAt' in record;
const hasOwnerFields = (record: Entity): record is Task | Step =>
  'ownerFields' in record;
// Scope propose (spec 2026-09-25, plan §1.4): every read, and of the writes
// only these two. The night shift proposes; it never writes the board.
const PROPOSE_COMMANDS: ReadonlySet<CommandName> = new Set([
  'proposal.create',
  'proposal.deliver',
]);
function requirePropose(actor: Actor) {
  if (actor.scope === 'read') fail('forbidden', 'У ключа недостаточно прав.');
}
function requireScope(actor: Actor, kind: EntityKind) {
  // Appearance is the owner's own preference: no agent scope reaches it, and
  // task.sync never touches it (TI-025).
  if (kind === 'appearance') {
    if (actor.kind !== 'owner')
      fail('forbidden', 'Оформление меняет только владелец.');
    return;
  }
  // The label catalogue is the owner's decision (2026-09-17): agents choose
  // from it and never extend or change it.
  if (kind === 'label') {
    if (actor.kind !== 'owner')
      fail('forbidden', 'Метки заводит и меняет только владелец.');
    return;
  }
  if (
    actor.scope === 'read' ||
    actor.scope === 'propose' ||
    (kind === 'project' && actor.scope !== 'write')
  )
    fail('forbidden', 'У ключа недостаточно прав.');
}
// -1, 0 or 1 for values a comparison operator already orders (BigInt, string).
function sign<T extends bigint | string>(x: T, y: T): number {
  if (x < y) return -1;
  return x > y ? 1 : 0;
}
// An ISO instant as a comparable string, or null when the value is not one.
const instant = (value: string) => {
  if (!z.iso.datetime({ offset: true }).safeParse(value).success) return null;
  const parts = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  return parts
    ? {
        seconds: Date.parse(`${parts[1]}${parts[3]}`),
        fraction: parts[2] ?? '',
      }
    : null;
};
/** @internal for tests */
export function compareOriginVersion(a: string, b: string): number | null {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return sign(BigInt(a), BigInt(b));
  const left = instant(a),
    right = instant(b);
  if (left && right) {
    const seconds = Math.sign(left.seconds - right.seconds);
    if (seconds) return seconds;
    const width = Math.max(left.fraction.length, right.fraction.length);
    return sign(
      left.fraction.padEnd(width, '0'),
      right.fraction.padEnd(width, '0'),
    );
  }

  return null;
}
function changesBetween(before: Entity | undefined, after: Entity): Changes {
  const a: Record<string, unknown> = before ?? {};
  const b: Record<string, unknown> = after;
  return Object.fromEntries(
    Object.keys(b)
      .filter(
        (k) =>
          !['revision', 'updatedAt', 'commentCount', 'checklist'].includes(k) &&
          (!before || !equal(a[k], b[k])),
      )
      .map((k) => [k, { from: before ? a[k] : null, to: b[k] }]),
  );
}
function records(state: WorkspaceState, kind: 'task'): Task[];
function records(state: WorkspaceState, kind: 'project'): Project[];
function records(state: WorkspaceState, kind: 'comment'): Comment[];
function records(state: WorkspaceState, kind: 'appearance'): Appearance[];
function records(state: WorkspaceState, kind: 'label'): Label[];
function records(state: WorkspaceState, kind: 'step'): Step[];
function records(state: WorkspaceState, kind: 'proposal'): Proposal[];
function records(state: WorkspaceState, kind: EntityKind): Entity[];
function records(state: WorkspaceState, kind: EntityKind): Entity[] {
  return state[ENTITIES[kind].collection];
}
function get(state: WorkspaceState, kind: 'task', id: string): Task;
function get(state: WorkspaceState, kind: 'project', id: string): Project;
function get(state: WorkspaceState, kind: 'comment', id: string): Comment;
function get(state: WorkspaceState, kind: 'appearance', id: string): Appearance;
function get(state: WorkspaceState, kind: 'label', id: string): Label;
function get(state: WorkspaceState, kind: 'step', id: string): Step;
function get(state: WorkspaceState, kind: 'proposal', id: string): Proposal;
function get(state: WorkspaceState, kind: EntityKind, id: string): Entity;
function get(state: WorkspaceState, kind: EntityKind, id: string): Entity {
  return (
    records(state, kind).find((r) => r.id === id) ??
    fail('not_found', 'Запись не найдена.')
  );
}
function assertMerge(
  kind: EntityKind,
  record: Entity,
  base: number,
  keys: string[],
  history: HistoryAccess,
) {
  if (base > record.revision) fail('invalid', 'Базовая версия из будущего.');
  if (base < record.revision) {
    const changed = new Set(
      history
        .forRecord(kind, record.id, base)
        .flatMap((e) =>
          Object.keys(e.changes).filter((k) => isSubjectField(kind, k)),
        ),
    );
    const overlap = keys.filter((k) => changed.has(k));
    if (overlap.length)
      fail('conflict', 'Запись изменилась. Ваш текст остался в форме.', {
        current: record,
        conflicts: [{ entityKind: kind, entityId: record.id, fields: overlap }],
      });
  }
}
type Position = { before?: string; after?: string };
function order(state: WorkspaceState, task: Task, position?: Position) {
  const column = state.tasks
    .filter(
      (t) =>
        t.id !== task.id && t.area === task.area && t.status === task.status,
    )
    .toSorted(byOrder);
  if (!position)
    return generateKeyBetween(column.at(-1)?.orderKey ?? null, null);
  const id = position.before ?? position.after;
  const n = column.findIndex((t) => t.id === id);
  if (n < 0)
    fail(
      'invalid',
      'Сосед должен быть другой задачей той же области и колонки.',
    );
  return position.before
    ? generateKeyBetween(column[n - 1]?.orderKey ?? null, column[n]!.orderKey)
    : generateKeyBetween(column[n]!.orderKey, column[n + 1]?.orderKey ?? null);
}
// The desk order (plan 13): a fractional key among the tasks in focus, at the
// end without a position, first, or next to a neighbour that is on the desk.
function focusOrder(
  state: WorkspaceState,
  task: Task,
  position?: FocusPosition,
): string {
  const desk = state.tasks
    .filter((t) => t.id !== task.id && t.focusKey !== null)
    .toSorted(byFocusKey);
  if (!position) return generateKeyBetween(desk.at(-1)?.focusKey ?? null, null);
  if ('first' in position)
    return generateKeyBetween(null, desk[0]?.focusKey ?? null);
  const id = 'after' in position ? position.after : position.before;
  const n = desk.findIndex((t) => t.id === id);
  if (n < 0) fail('invalid', 'Сосед должен быть другой задачей в фокусе.');
  return 'before' in position
    ? generateKeyBetween(desk[n - 1]?.focusKey ?? null, desk[n]!.focusKey)
    : generateKeyBetween(desk[n]!.focusKey, desk[n + 1]?.focusKey ?? null);
}
// The desk part of a task write: `focus` and `focusPosition` decide whether
// the task is on the desk and where; leaving it (by choice, by finishing or
// by archiving) stamps focusLeftAt, returning clears it.
function settleFocus(
  s: Session,
  record: Task,
  focus: boolean | undefined,
  position: FocusPosition | undefined,
) {
  if (position !== undefined && focus === false)
    fail('invalid', 'focusPosition требует focus: true.');
  const wants = position !== undefined ? true : focus;
  const off = record.status === 'done' || record.archived;
  if (wants === true && off)
    fail('invalid', 'Готовую или архивную задачу нельзя взять в фокус.');
  if (wants === true) {
    if (record.focusKey === null || position !== undefined)
      record.focusKey = focusOrder(s.state, record, position);
    record.focus = true;
    record.focusLeftAt = null;
  } else if ((wants === false || off) && record.focusKey !== null) {
    record.focus = false;
    record.focusKey = null;
    record.focusLeftAt = s.ctx.now;
  }
}
// `changedIds` are the records the command touched: on a conflict, `current`
// is the other member of the pair, the record that was not changed, so a
// client can show or merge into what really exists (TI-040). Every check
// here is a DomainError: a violation after the envelope was accepted is a
// stored, final rejection, never a ZodError (TI-009).
export function assertInvariants(
  state: WorkspaceState,
  changedIds: ReadonlySet<string> = new Set(),
) {
  const names = new Map<string, Project>(),
    keys = new Map<string, Task>(),
    focusKeys = new Map<string, Task>(),
    origins = new Map<string, Task>();
  const unchanged = <T extends { id: string }>(previous: T, record: T): T =>
    changedIds.has(previous.id) && !changedIds.has(record.id)
      ? record
      : previous;
  for (const p of state.projects) {
    const name = `${p.area}/${p.name.toLocaleLowerCase('ru').trim()}`;
    const previous = names.get(name);
    if (previous)
      fail('conflict', 'Проект с таким именем уже существует.', {
        current: unchanged(previous, p),
      });
    names.set(name, p);
  }
  const labelNames = new Map<string, Label>(),
    labelIds = new Set<string>();
  for (const l of state.labels) {
    if (labelIds.has(l.id)) fail('conflict', 'Слаг метки уже занят.');
    labelIds.add(l.id);
    if (l.archivedAt) continue;
    const name = l.name.toLocaleLowerCase('ru').trim();
    const previous = labelNames.get(name);
    if (previous)
      fail('conflict', 'Метка с таким названием уже есть.', {
        current: unchanged(previous, l),
      });
    labelNames.set(name, l);
  }
  if (labelNames.size > LIMITS.labels)
    fail('invalid', 'Слишком много меток: уберите лишние в архив.');
  for (const t of state.tasks) {
    if (
      t.projectId &&
      state.projects.find((p) => p.id === t.projectId)?.area !== t.area
    )
      fail('invalid', 'Проект должен принадлежать области задачи.');
    const key = `${t.area}/${t.status}/${t.orderKey}`;
    const occupant = keys.get(key);
    if (occupant) {
      const current = unchanged(occupant, t);
      fail('conflict', 'Прежнее место задачи уже занято.', {
        current,
        conflicts: [
          { entityKind: 'task', entityId: current.id, fields: ['orderKey'] },
        ],
      });
    }
    keys.set(key, t);
    // The desk (plan 13): focus mirrors the key, keys are unique, finished
    // and archived tasks are never on it.
    if (t.focus !== (t.focusKey !== null))
      fail('invalid', 'Признак фокуса и ключ стола расходятся.');
    if (t.focus && (t.status === 'done' || t.archived))
      fail('invalid', 'Готовая или архивная задача не может быть в фокусе.');
    if (t.focusKey !== null) {
      const holder = focusKeys.get(t.focusKey);
      if (holder) {
        const current = unchanged(holder, t);
        fail('conflict', 'Место на столе уже занято.', {
          current,
          conflicts: [
            { entityKind: 'task', entityId: current.id, fields: ['focusKey'] },
          ],
        });
      }
      focusKeys.set(t.focusKey, t);
    }
    if (
      Boolean(t.originSystem) !== Boolean(t.originRef) ||
      (!t.originSystem && t.originUrl)
    )
      fail('invalid', 'Укажите систему и идентификатор источника вместе.');
    if (t.originSystem) {
      const origin = JSON.stringify([t.originSystem, t.originRef]);
      const previous = origins.get(origin);
      if (previous)
        fail('conflict', 'Задача этого источника уже существует.', {
          current: unchanged(previous, t),
        });
      origins.set(origin, t);
    }
    if (
      t.labels.length > LIMITS.taskLabels ||
      new Set(t.labels).size !== t.labels.length
    )
      fail('invalid', 'Метки должны быть уникальными и помещаться в лимит.');
    if (!t.labels.every((id) => labelIds.has(id)))
      fail('invalid', 'Метка отсутствует в каталоге.');
  }
  // Steps (TI-095): one id across the workspace, a task that exists, a link
  // to another existing task, unique places among the live steps of a task
  // and no more live steps than the limit.
  const taskIds = new Set(state.tasks.map((t) => t.id));
  const stepIds = new Set<string>(),
    stepKeys = new Map<string, Step>(),
    liveCount = new Map<string, number>();
  for (const step of state.steps) {
    if (stepIds.has(step.id))
      fail('invalid', 'Идентификатор шага уже занят другой задачей.');
    stepIds.add(step.id);
    if (!taskIds.has(step.taskId))
      fail('invalid', 'Шаг ссылается на отсутствующую задачу.');
    if (
      step.linkedTaskId !== null &&
      (step.linkedTaskId === step.taskId || !taskIds.has(step.linkedTaskId))
    )
      fail('invalid', 'Связанная задача шага должна быть другой задачей.');
    if (step.removedAt !== null) continue;
    liveCount.set(step.taskId, (liveCount.get(step.taskId) ?? 0) + 1);
    const key = `${step.taskId}/${step.orderKey}`;
    const holder = stepKeys.get(key);
    if (holder) {
      const current = unchanged(holder, step);
      fail('conflict', 'Прежнее место шага уже занято.', {
        current,
        conflicts: [
          { entityKind: 'step', entityId: current.id, fields: ['orderKey'] },
        ],
      });
    }
    stepKeys.set(key, step);
  }
  for (const n of liveCount.values())
    if (n > LIMITS.checklistItems)
      fail('invalid', `В задаче не больше ${LIMITS.checklistItems} шагов.`);
  // Proposals (spec 2026-09-25): one id and one fingerprint for all time, a
  // number only while shown and never two shown under one number, tasks that
  // exist.
  const proposalIds = new Set<string>(),
    fingerprints = new Map<string, Proposal>(),
    numbers = new Map<number, Proposal>();
  for (const p of state.proposals) {
    if (proposalIds.has(p.id))
      fail('invalid', 'Идентификатор предложения уже занят.');
    proposalIds.add(p.id);
    const twin = fingerprints.get(p.fingerprint);
    if (twin)
      fail('conflict', 'Предложение с таким отпечатком уже есть.', {
        current: unchanged(twin, p),
      });
    fingerprints.set(p.fingerprint, p);
    if ((p.status === 'shown') !== (p.number !== null))
      fail('invalid', 'Номер есть только у показанного предложения.');
    if (p.number !== null) {
      const holder = numbers.get(p.number);
      if (holder)
        fail('conflict', 'Номер предложения уже занят.', {
          current: unchanged(holder, p),
        });
      numbers.set(p.number, p);
    }
    if (
      (p.taskId !== null && !taskIds.has(p.taskId)) ||
      (p.resultTaskId !== null && !taskIds.has(p.resultTaskId))
    )
      fail('invalid', 'Предложение ссылается на отсутствующую задачу.');
  }
}
// One command application: the cloned state, the context, the effects
// collected so far and `emit`, which records a change and stamps the record.
type Session = {
  state: WorkspaceState;
  ctx: CommandContext;
  history: HistoryAccess;
  effects: ChangeEffect[];
  name: CommandName;
  emit: (
    kind: EntityKind,
    before: Entity | undefined,
    after: Entity,
    command?: CommandName,
  ) => Changes;
};
const isAgent = (s: Session) => s.ctx.actor.kind !== 'owner';
type UndoInverse = {
  kind: EntityKind;
  record: Entity;
  values: Record<string, unknown>;
  base: number;
  keys: string[];
};
function applyUndo(s: Session, p: CommandOf<'undo'>['payload']): CommandResult {
  const target =
    'seq' in p
      ? [s.history.bySeq(p.seq)].filter((e) => e !== undefined)
      : s.history.forOperation(p.operationId);
  if (!target.length)
    fail('not_undoable', 'У операции нет отменяемых событий.');
  // Authority before semantics: an agent learns nothing about an operation
  // it may not undo. Owner decisions are never undone by agents; other
  // agents' operations are, within the key's scope.
  if (isAgent(s)) {
    if (target.some((e) => e.actorId === 'owner'))
      fail('forbidden', 'Агент не отменяет операции с событиями владельца.');
    for (const kind of new Set(target.map((e) => e.entityKind)))
      requireScope(s.ctx.actor, kind);
  }
  if (target.some((e) => e.command === 'project.create'))
    fail('not_undoable', 'Создание проекта не отменяется.');
  // A proposal comes and goes by its own commands: creating and showing are
  // the night shift's bookkeeping, and a decision goes back only whole, with
  // the task write it made (spec 2026-09-25, §5.1). By seq that holds for
  // every event of the operation, the task's included: the task write alone
  // would leave the proposal accepted with nothing behind it.
  if (
    target.some(
      (e) =>
        e.command === 'proposal.create' || e.command === 'proposal.deliver',
    )
  )
    fail('not_undoable', 'Создание и показ предложений не отменяются.');
  if ('seq' in p) {
    const operation = s.history.forOperation(target[0]!.operationId);
    if (
      operation.length > 1 &&
      operation.some((e) => e.entityKind === 'proposal')
    )
      fail(
        'not_undoable',
        'Решение по предложению отменяется только целиком: undo --operation.',
      );
  }
  const targetSeqs = new Set(target.map((e) => e.seq));
  const groups = new Map<string, DomainEvent[]>();
  for (const e of target) {
    const key = `${e.entityKind}/${e.entityId}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const conflicts: {
    entityKind: EntityKind;
    entityId: string;
    fields: string[];
  }[] = [];
  let firstConflict: Entity | undefined;
  const inverses: UndoInverse[] = [];
  for (const events of groups.values()) {
    events.sort((a, b) => a.seq - b.seq);
    const first = events[0]!;
    const kind = first.entityKind;
    const record = get(s.state, kind, first.entityId);
    const last = events.at(-1)!;
    const created = events.some((e) => e.changes.createdAt?.from === null);
    const net: Changes = {};
    for (const e of events)
      for (const [key, change] of Object.entries(e.changes)) {
        if (isSubjectField(kind, key))
          net[key] = {
            from: net[key] ? net[key].from : change.from,
            to: change.to,
          };
      }
    let values: Record<string, unknown>;
    if (created) {
      // Undoing a creation hides the record instead of deleting history.
      if (isTask(record)) values = record.archived ? {} : { archived: true };
      else if (isComment(record))
        values = record.deletedAt ? {} : { deletedAt: s.ctx.now };
      else if (isLabel(record))
        values = record.archivedAt ? {} : { archivedAt: s.ctx.now };
      else if (isStep(record))
        values = record.removedAt ? {} : { removedAt: s.ctx.now };
      else values = {};
    } else
      values = Object.fromEntries(
        Object.entries(net)
          .filter(([, v]) => !equal(v.from, v.to))
          .map(([k, v]) => [k, v.from]),
      );
    if (!created && !Object.keys(values).length) continue;
    requireScope(s.ctx.actor, kind);
    if (isComment(record) && isAgent(s) && record.actorId !== s.ctx.actor.id)
      fail('forbidden', 'Нельзя отменить чужой комментарий.');
    const keys = created
      ? Object.keys(record).filter((k) => isSubjectField(kind, k))
      : Object.keys(values);
    const later = s.history
      .forRecord(kind, record.id, last.recordRevision)
      .filter((e) => !targetSeqs.has(e.seq));
    const overlap = [
      ...new Set(
        later
          .flatMap((e) => Object.keys(e.changes))
          .filter((k) => keys.includes(k)),
      ),
    ];
    if (overlap.length) {
      conflicts.push({
        entityKind: kind,
        entityId: record.id,
        fields: overlap,
      });
      firstConflict ??= record;
    }
    if (!Object.keys(values).length) continue;
    inverses.push({ kind, record, values, base: last.recordRevision, keys });
  }
  if (conflicts.length)
    fail('conflict', 'После операции записи уже менялись.', {
      current: firstConflict,
      conflicts,
    });
  if (!inverses.length)
    fail('not_undoable', 'У операции нет отменяемого предметного эффекта.');
  const changed: Entity[] = [];
  let single: CommandResult | undefined;
  for (const inverse of inverses) {
    const before = structuredClone(inverse.record);
    Object.assign(inverse.record, inverse.values);
    const changes = s.emit(inverse.kind, before, inverse.record);
    if (isComment(inverse.record) && isComment(before)) {
      const task = get(s.state, 'task', inverse.record.taskId);
      task.commentCount +=
        Number(!inverse.record.deletedAt) - Number(!before.deletedAt);
    }
    changed.push(inverse.record);
    single = { record: inverse.record, changes };
  }
  return inverses.length === 1
    ? single!
    : { record: null, records: changed, changes: {} };
}
function applyProjectCreate(
  s: Session,
  p: CommandOf<'project.create'>['payload'],
): CommandResult {
  const id = p.id ?? s.ctx.ids();
  if (s.state.projects.some((r) => r.id === id))
    fail('conflict', 'Идентификатор проекта уже занят.');
  const record: Project = {
    id,
    area: p.area,
    name: p.name,
    color: p.color.toLowerCase(),
    description: p.description ?? '',
    revision: 0,
    createdAt: s.ctx.now,
    updatedAt: s.ctx.now,
  };
  s.state.projects.push(record);
  return { record, changes: s.emit('project', undefined, record) };
}
function applyProjectUpdate(
  s: Session,
  p: CommandOf<'project.update'>['payload'],
): CommandResult {
  const record = get(s.state, 'project', p.id);
  const before = structuredClone(record);
  const patch: Partial<Pick<Project, 'name' | 'color' | 'description'>> = {
    ...(p.name !== undefined ? { name: p.name } : {}),
    ...(p.color !== undefined ? { color: p.color.toLowerCase() } : {}),
    ...(p.description !== undefined ? { description: p.description } : {}),
  };
  assertMerge('project', record, p.baseRevision, Object.keys(patch), s.history);
  Object.assign(record, patch);
  return { record, changes: s.emit('project', before, record) };
}
function applyLabelCreate(
  s: Session,
  p: CommandOf<'label.create'>['payload'],
): CommandResult {
  const taken = new Set(s.state.labels.map((l) => l.id));
  const id = p.id ?? uniqueSlug(p.name, taken);
  if (taken.has(id))
    fail('conflict', 'Слаг метки уже занят.', {
      current: get(s.state, 'label', id),
    });
  const record: Label = {
    id,
    name: p.name,
    color: p.color.toLowerCase(),
    description: p.description,
    position: Math.max(0, ...s.state.labels.map((l) => l.position)) + 1,
    archivedAt: null,
    revision: 0,
    createdAt: s.ctx.now,
    updatedAt: s.ctx.now,
  };
  s.state.labels.push(record);
  return { record, changes: s.emit('label', undefined, record) };
}
function applyLabelUpdate(
  s: Session,
  p: CommandOf<'label.update'>['payload'],
): CommandResult {
  const record = get(s.state, 'label', p.id);
  const before = structuredClone(record);
  const patch: Partial<Pick<Label, 'name' | 'color' | 'description'>> = {
    ...(p.name !== undefined ? { name: p.name } : {}),
    ...(p.color !== undefined ? { color: p.color.toLowerCase() } : {}),
    ...(p.description !== undefined ? { description: p.description } : {}),
  };
  assertMerge('label', record, p.baseRevision, Object.keys(patch), s.history);
  Object.assign(record, patch);
  return { record, changes: s.emit('label', before, record) };
}
// Archiving takes the label off every task in the same operation, so no task
// ever points at an archived label; restoring puts none of them back.
function applyLabelArchive(
  s: Session,
  p: CommandOf<'label.archive' | 'label.restore'>['payload'],
  archive: boolean,
): CommandResult {
  const record = get(s.state, 'label', p.id);
  const before = structuredClone(record);
  assertMerge('label', record, p.baseRevision, ['archivedAt'], s.history);
  record.archivedAt = archive ? s.ctx.now : null;
  const changes = s.emit('label', before, record);
  if (archive)
    for (const task of s.state.tasks) {
      if (!task.labels.includes(p.id)) continue;
      const previous = structuredClone(task);
      task.labels = task.labels.filter((id) => id !== p.id);
      s.emit('task', previous, task);
    }
  return { record, changes };
}
function applyAppearanceUpdate(
  s: Session,
  p: CommandOf<'appearance.update'>['payload'],
): CommandResult {
  const record = get(s.state, 'appearance', DEFAULT_APPEARANCE_ID);
  const before = structuredClone(record);
  const patch: Partial<Pick<Appearance, 'mode' | 'skinId' | 'hideP3'>> = {
    ...(p.mode !== undefined ? { mode: p.mode } : {}),
    ...(p.skinId !== undefined ? { skinId: p.skinId } : {}),
    ...(p.hideP3 !== undefined ? { hideP3: p.hideP3 } : {}),
  };
  assertMerge(
    'appearance',
    record,
    p.baseRevision,
    Object.keys(patch),
    s.history,
  );
  Object.assign(record, patch);
  return { record, changes: s.emit('appearance', before, record) };
}
function applyCommentAdd(
  s: Session,
  p: CommandOf<'comment.add'>['payload'],
): CommandResult {
  const task = get(s.state, 'task', p.taskId);
  const id = p.id ?? s.ctx.ids();
  if (s.state.comments.some((c) => c.id === id))
    fail('conflict', 'Идентификатор комментария уже занят.');
  const record: Comment = {
    id,
    taskId: task.id,
    actorId: s.ctx.actor.id,
    actorLabel: s.ctx.actor.label,
    text: p.text,
    revision: 0,
    createdAt: s.ctx.now,
    deletedAt: null,
  };
  s.state.comments.push(record);
  task.commentCount++;
  return { record, changes: s.emit('comment', undefined, record) };
}
function applyCommentRemove(
  s: Session,
  p: CommandOf<'comment.remove'>['payload'],
): CommandResult {
  const record = get(s.state, 'comment', p.commentId);
  if (isAgent(s) && record.actorId !== s.ctx.actor.id)
    fail('forbidden', 'Нельзя удалить чужой комментарий.');
  const before = structuredClone(record);
  if (!record.deletedAt) {
    record.deletedAt = s.ctx.now;
    get(s.state, 'task', record.taskId).commentCount--;
  }
  return { record, changes: s.emit('comment', before, record) };
}
type Origin = CommandOf<'task.sync'>['payload']['origin'];
type CreateFields = CommandOf<'task.sync'>['payload']['fields'];
// The sync side of ownerOnlyFields: focusPosition is a direct-write field and
// has no place in a creation payload, so `satisfies` keeps the two lists honest.
const ownerOnlyCreateFields = [
  'focus',
] as const satisfies readonly (keyof CreateFields &
  (typeof ownerOnlyFields)[number])[];
const findByOrigin = (state: WorkspaceState, origin: Origin | undefined) =>
  origin
    ? state.tasks.find(
        (t) => t.originSystem === origin.system && t.originRef === origin.ref,
      )
    : undefined;
// Direct agent commands never set owner-only fields; task.sync skips them.
function refuseOwnerOnly(s: Session, fields: object) {
  if (isAgent(s) && ownerOnlyFields.some((key) => Object.hasOwn(fields, key)))
    fail('forbidden', 'Поле focus меняет только владелец.');
}
function createTask(
  s: Session,
  id: string | undefined,
  fields: CreateFields,
  origin: Origin | undefined,
  position: Position | undefined,
): Task {
  if (
    origin?.version &&
    compareOriginVersion(origin.version, origin.version) === null
  )
    fail('invalid', 'Версия источника должна задавать порядок его состояний.');
  const taskId = id ?? s.ctx.ids();
  if (s.state.tasks.some((t) => t.id === taskId))
    fail('conflict', 'Идентификатор задачи уже занят.');
  const record: Task = {
    id: taskId,
    area: fields.area,
    projectId: fields.projectId ?? null,
    title: fields.title,
    status: fields.status ?? 'todo',
    priority: fields.priority ?? DEFAULT_PRIORITY,
    labels: writtenLabels(s.state, fields.labels),
    closes: fields.closes ?? null,
    note: fields.note ?? '',
    due: fields.due ?? null,
    waitingFor: fields.waitingFor ?? '',
    followUp: fields.followUp ?? null,
    orderKey: '',
    focus: false,
    focusKey: null,
    focusLeftAt: null,
    archived: false,
    checklist: [],
    commentCount: 0,
    originSystem: origin?.system ?? null,
    originRef: origin?.ref ?? null,
    originUrl: origin?.url ?? null,
    originVersion: origin?.version ?? null,
    createdBy: s.ctx.actor.id,
    createdByLabel: s.ctx.actor.label,
    ownerTouchedAt: null,
    ownerFields: [],
    revision: 0,
    createdAt: s.ctx.now,
    updatedAt: s.ctx.now,
  };
  record.orderKey = order(s.state, record, position);
  s.state.tasks.push(record);
  if (fields.focus) settleFocus(s, record, true, undefined);
  return record;
}
function applyTaskCreate(
  s: Session,
  p: CommandOf<'task.create'>['payload'],
): CommandResult {
  refuseOwnerOnly(s, p);
  const existing = findByOrigin(s.state, p.origin);
  if (existing) return { record: existing, changes: {}, existing: true };
  const { id, origin, position, ...fields } = p;
  const record = createTask(s, id, fields, origin, position);
  const changes = s.emit('task', undefined, record);
  createSteps(s, record, fields.checklist ?? []);
  return { record, changes };
}
function applyTaskSync(
  s: Session,
  p: CommandOf<'task.sync'>['payload'],
): CommandResult {
  const { origin } = p;
  // In sync the owner-only fields never reject the call: they are reported
  // as skipped (reason owner) whatever the owner has or has not touched.
  const skipped: { field: string; reason: string }[] = [];
  // Both owner-only keys are optional in CreateFields, so dropping them keeps
  // the payload a complete set of creation fields.
  let fields: CreateFields = p.fields;
  if (isAgent(s))
    for (const key of ownerOnlyCreateFields)
      if (Object.hasOwn(fields, key)) {
        skipped.push({ field: key, reason: 'owner' });
        const { [key]: _dropped, ...rest } = fields;
        fields = rest;
      }
  if (fields.labels)
    fields = { ...fields, labels: writtenLabels(s.state, fields.labels) };
  const existing = findByOrigin(s.state, origin);
  if (!existing) {
    const record = createTask(s, undefined, fields, origin, undefined);
    const changes = s.emit('task', undefined, record);
    createSteps(s, record, fields.checklist ?? []);
    return { record, changes, applied: Object.keys(fields), skipped };
  }
  const record = existing;
  const before = structuredClone(record);
  let reason: string | undefined;
  if (!origin.version || !record.originVersion) reason = 'freshness_unknown';
  else {
    const comparison = compareOriginVersion(
      origin.version,
      record.originVersion,
    );
    if (comparison === null) reason = 'version_incomparable';
    else if (comparison <= 0) reason = 'stale';
  }
  if (reason) return { record, changes: {}, skipped: 'all', reason };
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    // Steps are records the board owns once the task exists (TI-095): a
    // source writes them only when it creates the task.
    if (key === 'checklist') {
      skipped.push({ field: key, reason: 'locked' });
      continue;
    }
    if (
      record.ownerTouchedAt &&
      (record.ownerFields.includes(key) || ownerLockedFields.includes(key))
    )
      skipped.push({
        field: key,
        reason: record.ownerFields.includes(key) ? 'owner' : 'locked',
      });
    else patch[key] = value;
  }
  if (origin.url !== undefined) {
    if (record.ownerTouchedAt && record.ownerFields.includes('originUrl'))
      skipped.push({ field: 'originUrl', reason: 'owner' });
    else patch.originUrl = origin.url;
  }
  record.originVersion = origin.version!;
  const moves =
    (patch.area !== undefined && patch.area !== record.area) ||
    (patch.status !== undefined && patch.status !== record.status);
  Object.assign(record, patch);
  if (moves) record.orderKey = order(s.state, record, undefined);
  return {
    record,
    changes: s.emit('task', before, record),
    applied: Object.keys(patch),
    skipped,
  };
}
// TI-095 (owner decision 2026-09-18): the owner's steps are protected by what
// they say, not as one list. Ticking a step done and adding new steps is the
// agent's ordinary work on a plan the owner wrote or corrected; rewording,
// removing or reordering the existing steps, or clearing a tick, changes his
// decision and needs confirmOwnerFields.
function overridesOwnerSteps(
  current: Task['checklist'],
  next: Task['checklist'],
): boolean {
  const kept = next.filter((item) => current.some((c) => c.id === item.id));
  if (kept.length !== current.length) return true;
  return current.some((before, index) => {
    const after = kept[index]!;
    return (
      after.id !== before.id ||
      after.text !== before.text ||
      (before.done && !after.done)
    );
  });
}
// The common tail of every direct task write: merge check against the base
// revision, owner-field confirmation for agents, the patch itself and a new
// order key when the task moves.
function commitTaskPatch(
  s: Session,
  record: Task,
  baseRevision: number,
  input: Record<string, unknown>,
  position: Position | undefined,
  forceMove = false,
  focusPosition?: FocusPosition,
): CommandResult {
  const before = structuredClone(record);
  const { focus, ...patch } = input as { focus?: boolean } & Record<
    string,
    unknown
  >;
  if (Array.isArray(patch.labels))
    patch.labels = writtenLabels(s.state, patch.labels as string[]);
  const moves =
    forceMove ||
    position !== undefined ||
    (patch.area !== undefined && patch.area !== record.area) ||
    (patch.status !== undefined && patch.status !== record.status);
  const desk = focus !== undefined || focusPosition !== undefined;
  assertMerge(
    'task',
    record,
    baseRevision,
    [
      ...Object.keys(input),
      ...(moves ? ['orderKey'] : []),
      ...(desk ? ['focus', 'focusKey'] : []),
    ],
    s.history,
  );
  // A direct agent command that changes a field the owner decided on needs
  // an explicit confirmation in the envelope; the confirmed fields stay in
  // the result as the trace of that delegation.
  const confirmed: string[] = [];
  if (isAgent(s) && record.ownerTouchedAt) {
    const current: Record<string, unknown> = record;
    const overridden = Object.keys(patch).filter(
      (key) =>
        record.ownerFields.includes(key) &&
        (key === 'checklist'
          ? overridesOwnerSteps(
              record.checklist,
              patch.checklist as Task['checklist'],
            )
          : !equal(patch[key], current[key])),
    );
    if (overridden.length && !s.ctx.confirmOwnerFields)
      fail(
        'forbidden',
        'Поле защищено владельцем: подтвердите поручение флагом confirmOwnerFields: true.',
        {
          current: record,
          conflicts: [
            { entityKind: 'task', entityId: record.id, fields: overridden },
          ],
        },
      );
    confirmed.push(...overridden);
  }
  Object.assign(record, patch);
  if (moves) record.orderKey = order(s.state, record, position);
  settleFocus(s, record, focus, focusPosition);
  return {
    record,
    changes: s.emit('task', before, record),
    ...(confirmed.length ? { confirmedOwnerFields: confirmed } : {}),
  };
}
function applyTaskWrite(
  s: Session,
  command: CommandOf<
    'task.update' | 'task.save' | 'task.move' | 'task.archive' | 'task.restore'
  >,
): CommandResult {
  const p = command.payload;
  const record = get(s.state, 'task', p.id);
  switch (command.command) {
    case 'task.update': {
      const {
        id: _id,
        baseRevision,
        focusPosition,
        ...fields
      } = command.payload;
      refuseOwnerOnly(s, command.payload);
      return commitTaskPatch(
        s,
        record,
        baseRevision,
        fields,
        undefined,
        false,
        focusPosition,
      );
    }
    case 'task.save': {
      const { fields = {}, status, checklist, position } = command.payload;
      refuseOwnerOnly(s, fields);
      const { focusPosition, ...rest } = fields;
      const result = commitTaskPatch(
        s,
        record,
        p.baseRevision,
        { ...rest, ...(status !== undefined ? { status } : {}) },
        position,
        false,
        focusPosition,
      );
      // The checklist of a save is the plan as the client sees it: it
      // becomes per-step changes against the live steps (TI-095).
      const steps =
        checklist === undefined ? [] : syncSteps(s, record, checklist);
      return steps.length ? { ...result, records: [record, ...steps] } : result;
    }
    case 'task.move': {
      const { status, before, after } = command.payload;
      return commitTaskPatch(
        s,
        record,
        p.baseRevision,
        { status },
        before || after ? { before, after } : undefined,
        true,
      );
    }
    case 'task.archive':
      return commitTaskPatch(
        s,
        record,
        p.baseRevision,
        { archived: true },
        undefined,
      );
    case 'task.restore':
      return commitTaskPatch(
        s,
        record,
        p.baseRevision,
        { archived: false },
        undefined,
      );
    default:
      return assertNever(command);
  }
}
// Steps as records (TI-095). Every change of a step refreshes the task's
// `checklist`, the projection readers see (`emit` does it).
function refreshChecklist(state: WorkspaceState, taskId: string) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (task) task.checklist = projectChecklist(state.steps, taskId);
}
function getStep(s: Session, taskId: string, itemId: string): Step {
  const step = s.state.steps.find((x) => x.id === itemId);
  if (!step || step.taskId !== taskId) fail('not_found', 'Шаг не найден.');
  if (step.removedAt !== null) fail('not_found', 'Шаг удалён.');
  return step;
}
type StepInput = {
  id?: string;
  text: string;
  done?: boolean;
  result?: string;
  removed?: boolean;
};
// A new step at `index` among the live steps of its task (past the end
// appends). A step created done is credited to its creator.
function createStep(
  s: Session,
  task: Task,
  input: StepInput,
  index?: number,
): { record: Step; changes: Changes } {
  const id = input.id ?? s.ctx.ids();
  if (s.state.steps.some((x) => x.id === id))
    fail('conflict', 'Идентификатор шага уже занят.');
  const live = liveSteps(s.state.steps, task.id);
  if (live.length >= LIMITS.checklistItems)
    fail('invalid', `В задаче не больше ${LIMITS.checklistItems} шагов.`);
  const done = input.done ?? false;
  const record: Step = {
    id,
    taskId: task.id,
    text: input.text,
    orderKey: stepKeyAt(live, index ?? live.length),
    done,
    doneAt: done ? s.ctx.now : null,
    doneBy: done ? s.ctx.actor.id : null,
    doneByLabel: done ? s.ctx.actor.label : null,
    result: input.result ?? '',
    linkedTaskId: null,
    removedAt: null,
    createdBy: s.ctx.actor.id,
    createdByLabel: s.ctx.actor.label,
    ownerTouchedAt: null,
    ownerFields: [],
    revision: 0,
    createdAt: s.ctx.now,
    updatedAt: s.ctx.now,
  };
  s.state.steps.push(record);
  return { record, changes: s.emit('step', undefined, record) };
}
function createSteps(s: Session, task: Task, items: readonly StepInput[]) {
  for (const item of items) if (!item.removed) createStep(s, task, item);
}
type StepPatch = Partial<
  Pick<
    Step,
    'text' | 'orderKey' | 'done' | 'result' | 'linkedTaskId' | 'removedAt'
  >
>;
// The common tail of every direct step write: merge check against the step's
// revision, owner-field confirmation for agents (the same rule as tasks, on
// the fields of this step alone), the tick's bookkeeping and the event.
function commitStepPatch(
  s: Session,
  record: Step,
  baseRevision: number,
  patch: StepPatch,
): CommandResult {
  const before = structuredClone(record);
  const keys = Object.keys(patch);
  assertMerge('step', record, baseRevision, keys, s.history);
  const confirmed: string[] = [];
  if (isAgent(s) && record.ownerTouchedAt) {
    const current: Record<string, unknown> = record;
    const wanted: Record<string, unknown> = patch;
    // Removing a step discards everything the owner decided on it, so a
    // step with any owner field is protected from removal as a whole.
    const overridden = keys.filter(
      (key) =>
        (record.ownerFields.includes(key) ||
          (key === 'removedAt' && record.ownerFields.length > 0)) &&
        !equal(wanted[key], current[key]),
    );
    if (overridden.length && !s.ctx.confirmOwnerFields)
      fail(
        'forbidden',
        'Поле защищено владельцем: подтвердите поручение флагом confirmOwnerFields: true.',
        {
          current: record,
          conflicts: [
            { entityKind: 'step', entityId: record.id, fields: overridden },
          ],
        },
      );
    confirmed.push(...overridden);
  }
  Object.assign(record, patch);
  if (patch.done !== undefined && patch.done !== before.done) {
    record.doneAt = patch.done ? s.ctx.now : null;
    record.doneBy = patch.done ? s.ctx.actor.id : null;
    record.doneByLabel = patch.done ? s.ctx.actor.label : null;
  }
  return {
    record,
    changes: s.emit('step', before, record),
    ...(confirmed.length ? { confirmedOwnerFields: confirmed } : {}),
  };
}
// Fresh keys for the live steps in the order given; nothing moves when the
// order did not change.
function reorderSteps(
  s: Session,
  live: readonly Step[],
  ids: readonly string[],
): Step[] {
  if (live.map((x) => x.id).join(',') === ids.join(',')) return [];
  const keys = generateNKeysBetween(null, null, ids.length);
  const changed: Step[] = [];
  for (const [index, id] of ids.entries()) {
    const step = live.find((x) => x.id === id)!;
    if (step.orderKey === keys[index]) continue;
    commitStepPatch(s, step, step.revision, { orderKey: keys[index]! });
    changed.push(step);
  }
  return changed;
}
// task.save: the client's list against the live steps. Known steps are
// patched (their `revision` is the base when given), steps flagged `removed`
// are removed, new ones are created after the listed step before them, and
// the listed steps take the order of the list. A step the list does not name
// is left alone: a client never removes what it has not seen (an agent may
// have added it meanwhile).
function syncSteps(
  s: Session,
  task: Task,
  items: readonly (StepInput & { revision?: number })[],
): Step[] {
  const byId = new Map(liveSteps(s.state.steps, task.id).map((x) => [x.id, x]));
  const changed: Step[] = [];
  const listed: string[] = [];
  let anchor: Step | undefined;
  for (const item of items) {
    const existing = item.id ? byId.get(item.id) : undefined;
    if (item.removed) {
      if (existing) {
        commitStepPatch(s, existing, item.revision ?? existing.revision, {
          removedAt: s.ctx.now,
        });
        changed.push(existing);
      }
      continue;
    }
    if (!existing) {
      const live = liveSteps(s.state.steps, task.id);
      const index = anchor ? live.findIndex((x) => x.id === anchor!.id) + 1 : 0;
      const { record } = createStep(s, task, item, index);
      changed.push(record);
      listed.push(record.id);
      anchor = record;
      continue;
    }
    const patch: StepPatch = {
      ...(item.text !== existing.text ? { text: item.text } : {}),
      ...(item.done !== undefined && item.done !== existing.done
        ? { done: item.done }
        : {}),
      ...(item.result !== undefined && item.result !== existing.result
        ? { result: item.result }
        : {}),
    };
    if (Object.keys(patch).length) {
      commitStepPatch(s, existing, item.revision ?? existing.revision, patch);
      changed.push(existing);
    }
    listed.push(existing.id);
    anchor = existing;
  }
  const live = liveSteps(s.state.steps, task.id);
  const named = new Set(listed);
  const current = live.filter((x) => named.has(x.id)).map((x) => x.id);
  if (current.join(',') !== listed.join(',')) {
    const queue = [...listed];
    const target = live.map((x) => (named.has(x.id) ? queue.shift()! : x.id));
    for (const step of reorderSteps(s, live, target))
      if (!changed.includes(step)) changed.push(step);
  }
  return changed;
}
function applyChecklist(
  s: Session,
  command: CommandOf<
    | 'checklist.add'
    | 'checklist.update'
    | 'checklist.remove'
    | 'checklist.move'
    | 'checklist.reorder'
    | 'checklist.promote'
  >,
): CommandResult {
  const task = get(s.state, 'task', command.payload.taskId);
  switch (command.command) {
    case 'checklist.add': {
      const p = command.payload;
      return createStep(s, task, { id: p.id, text: p.text }, p.position);
    }
    case 'checklist.update': {
      const p = command.payload;
      const record = getStep(s, task.id, p.itemId);
      if (p.linkedTaskId) {
        if (p.linkedTaskId === task.id)
          fail('invalid', 'Шаг нельзя связать с его собственной задачей.');
        get(s.state, 'task', p.linkedTaskId);
      }
      return commitStepPatch(s, record, p.baseRevision, {
        ...(p.text !== undefined ? { text: p.text } : {}),
        ...(p.done !== undefined ? { done: p.done } : {}),
        ...(p.result !== undefined ? { result: p.result } : {}),
        ...(p.linkedTaskId !== undefined
          ? { linkedTaskId: p.linkedTaskId }
          : {}),
      });
    }
    case 'checklist.remove': {
      const p = command.payload;
      const record = getStep(s, task.id, p.itemId);
      return commitStepPatch(s, record, p.baseRevision, {
        removedAt: s.ctx.now,
      });
    }
    case 'checklist.move': {
      const p = command.payload;
      const record = getStep(s, task.id, p.itemId);
      const others = liveSteps(s.state.steps, task.id).filter(
        (x) => x.id !== record.id,
      );
      const n = others.findIndex((x) => x.id === (p.before ?? p.after));
      if (n < 0)
        fail('invalid', 'Сосед должен быть другим шагом той же задачи.');
      const orderKey = p.before
        ? generateKeyBetween(
            others[n - 1]?.orderKey ?? null,
            others[n]!.orderKey,
          )
        : generateKeyBetween(
            others[n]!.orderKey,
            others[n + 1]?.orderKey ?? null,
          );
      return commitStepPatch(s, record, p.baseRevision, { orderKey });
    }
    case 'checklist.reorder': {
      const ids = command.payload.itemIds;
      const live = liveSteps(s.state.steps, task.id);
      if (
        ids.length !== live.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !live.some((x) => x.id === id))
      )
        fail('invalid', 'Укажите все шаги без повторов.');
      const changed = reorderSteps(s, live, ids);
      return { record: task, records: changed, changes: {} };
    }
    case 'checklist.promote': {
      // One operation: the step grows into a task of the same area and
      // direction, and the step points at it. The parent's priority and
      // labels carry over unless given.
      const p = command.payload;
      const step = getStep(s, task.id, p.itemId);
      if (step.linkedTaskId !== null)
        fail('invalid', 'Шаг уже вынесен в задачу.');
      const child = createTask(
        s,
        p.id,
        {
          area: task.area,
          projectId: p.projectId !== undefined ? p.projectId : task.projectId,
          title: p.title ?? step.text,
          note: `Шаг задачи «${task.title}» (${task.id}).`,
          priority: p.priority ?? task.priority,
          labels: task.labels,
        },
        undefined,
        undefined,
      );
      const changes = s.emit('task', undefined, child);
      const linked = commitStepPatch(s, step, p.baseRevision, {
        linkedTaskId: child.id,
      });
      return {
        record: child,
        records: [child, step],
        changes,
        ...(linked.confirmedOwnerFields
          ? { confirmedOwnerFields: linked.confirmedOwnerFields }
          : {}),
      };
    }
    default:
      return assertNever(command);
  }
}
// Agent proposals (spec 2026-09-25, plan 2026-09-25-proposals-phase1 §1.2).
type ProposalTaskCommand = CommandOf<(typeof PROPOSAL_COMMANDS)[number]>;
type ProposedCommand = Proposal['command'];
// A proposal is created once per fingerprint for all time: a repeat answers
// the earlier record in whatever status it is, so a refusal holds.
function applyProposalCreate(
  s: Session,
  p: CommandOf<'proposal.create'>['payload'],
): CommandResult {
  const earlier = s.state.proposals.find(
    (x) => x.fingerprint === p.fingerprint,
  );
  if (earlier)
    return { record: earlier, changes: {}, proposal: earlier, existing: true };
  const id = p.id ?? s.ctx.ids();
  if (s.state.proposals.some((x) => x.id === id))
    fail('conflict', 'Идентификатор предложения уже занят.');
  // The payload is stored as its command reads it (trimmed): the morning
  // message shows exactly what «да» will execute.
  const payload: Record<string, unknown> = commandPayloadSchemas[
    p.command.command
  ].parse(p.command.payload);
  const change = p.kind === 'task_change';
  const taskId = change ? String(payload.id) : null;
  if (taskId !== null) {
    const task =
      s.state.tasks.find((t) => t.id === taskId) ??
      fail('not_found', 'Задача предложения не найдена.');
    if (task.archived)
      fail('invalid', 'Задача в архиве: предложение по ней не создаётся.');
  }
  const record: Proposal = {
    id,
    kind: p.kind,
    taskId,
    baseRevision: change ? Number(payload.baseRevision) : null,
    command: { command: p.command.command, payload },
    reason: p.reason,
    evidence: p.evidence,
    fingerprint: p.fingerprint,
    rank: p.rank,
    status: 'queued',
    number: null,
    shownOn: null,
    decidedAt: null,
    decidedBy: null,
    decidedByLabel: null,
    decisionReason: null,
    patch: null,
    resultTaskId: null,
    createdBy: s.ctx.actor.id,
    createdByLabel: s.ctx.actor.label,
    revision: 0,
    createdAt: s.ctx.now,
    updatedAt: s.ctx.now,
  };
  s.state.proposals.push(record);
  const changes = s.emit('proposal', undefined, record);
  return { record, changes, proposal: record, existing: false };
}
// An outcome: the number is free again, the actor and the moment are kept.
function decideProposal(
  s: Session,
  proposal: Proposal,
  status: Proposal['status'],
  reason: string | null,
  extra: Partial<Pick<Proposal, 'patch' | 'resultTaskId'>> = {},
): Changes {
  const before = structuredClone(proposal);
  Object.assign(proposal, {
    status,
    number: null,
    decidedAt: s.ctx.now,
    decidedBy: s.ctx.actor.id,
    decidedByLabel: s.ctx.actor.label,
    decisionReason: reason,
    ...extra,
  });
  return s.emit('proposal', before, proposal);
}
const PROPOSAL_NUMBERS = Array.from(
  { length: LIMITS.proposalNumbers },
  (_, i) => i + 1,
);
// The morning delivery (plan §1.2, steps 1-5), one operation. A day that
// already showed proposals answers what is still shown from it and changes
// nothing: a repeat is idempotent, and the owner never gets more than the
// limit in one day, even after answering the first batch.
function applyProposalDeliver(
  s: Session,
  p: CommandOf<'proposal.deliver'>['payload'],
): CommandResult {
  const today = todayInTimezone(s.ctx.timezone ?? 'Europe/Moscow', s.ctx.now);
  const list = s.state.proposals;
  const summary = (expired: string[], stale: string[]): CommandResult => ({
    record: null,
    changes: {},
    date: today,
    shown: list
      .filter((x) => x.status === 'shown' && x.shownOn === today)
      .toSorted((a, b) => a.number! - b.number!),
    queued: list.filter((x) => x.status === 'queued').length,
    expired,
    stale,
  });
  if (list.some((x) => x.shownOn === today)) return summary([], []);
  const expired: string[] = [],
    stale: string[] = [];
  const cutoff = addDays(today, -LIMITS.proposalShownDays);
  for (const x of list)
    if (x.status === 'shown' && x.shownOn! < cutoff) {
      decideProposal(
        s,
        x,
        'expired',
        `нет ответа ${LIMITS.proposalShownDays} дня после показа`,
      );
      expired.push(x.id);
    }
  for (const x of list) {
    if (x.status !== 'queued' && x.status !== 'shown') continue;
    const reason = staleReason(s.state, x);
    if (!reason) continue;
    decideProposal(s, x, 'stale', reason);
    stale.push(x.id);
  }
  const taken = new Set(
    list.flatMap((x) => (x.status === 'shown' ? [x.number!] : [])),
  );
  let left = p.limit ?? LIMITS.proposalsPerDay;
  for (const x of list.filter((y) => y.status === 'queued').toSorted(byQueue)) {
    const number = PROPOSAL_NUMBERS.find((n) => !taken.has(n));
    if (left === 0 || number === undefined) break;
    const before = structuredClone(x);
    Object.assign(x, { status: 'shown', number, shownOn: today });
    s.emit('proposal', before, x);
    taken.add(number);
    left--;
  }
  return summary(expired, stale);
}
// The owner's patch over the proposed payload, one level deep. The key
// `command` changes the kind of action on the same task (spec §5.4: «в
// архив» becomes «закрыть»); the new payload starts from the task and the
// revision the proposal saw.
function patchedCommand(
  proposal: Proposal,
  patch: Record<string, unknown> | undefined,
): ProposedCommand {
  if (!patch) return proposal.command;
  const { command: name, ...fields } = patch;
  if (name === undefined || name === proposal.command.command)
    return {
      command: proposal.command.command,
      payload: { ...proposal.command.payload, ...fields },
    };
  const known =
    PROPOSAL_COMMANDS.find((command) => command === name) ??
    fail('invalid', 'Правка владельца не подходит к предложению.', {
      issues: [
        {
          path: 'payload.patch.command',
          message: `Ожидается одна из команд: ${PROPOSAL_COMMANDS.join(', ')}`,
        },
      ],
    });
  return {
    command: known,
    payload:
      proposal.kind === 'task_change'
        ? {
            id: proposal.taskId,
            baseRevision: proposal.baseRevision,
            ...fields,
          }
        : fields,
  };
}
// Where an issue of the patched command points inside the accept payload.
function patchIssuePath(path: (string | number)[]): string {
  const [head, next, ...rest] = path;
  let inside = path;
  if (head === 'command') inside = next === 'payload' ? rest : ['command'];
  return formatIssuePath(['payload', 'patch', ...inside]);
}
// The proposed task command runs as the owner's instruction: he answered
// «да» to this exact change, so his protected fields count as confirmed. Its
// events carry the task command's own name, so the task's history reads as
// an ordinary write of the accepting agent.
function runProposedCommand(
  s: Session,
  command: ProposalTaskCommand,
): CommandResult {
  requireScope(s.ctx.actor, 'task');
  const inner: Session = {
    ...s,
    ctx: { ...s.ctx, confirmOwnerFields: true },
    name: command.command,
    emit: (kind, before, after, cmd = command.command) =>
      s.emit(kind, before, after, cmd),
  };
  return command.command === 'task.create'
    ? applyTaskCreate(inner, command.payload)
    : applyTaskWrite(inner, command);
}
function applyProposalAccept(
  s: Session,
  p: CommandOf<'proposal.accept'>['payload'],
): CommandResult {
  const proposal = findProposal(s.state, p.ref);
  if (proposal.status !== 'shown')
    fail('conflict', closedMessage(proposal.status), { current: proposal });
  const command = patchedCommand(proposal, p.patch);
  const issues = proposalCommandIssues({
    kind: proposal.kind,
    taskId: proposal.taskId,
    baseRevision: proposal.baseRevision,
    command,
  });
  if (issues.length)
    fail('invalid', 'Правка владельца не подходит к предложению.', {
      issues: issues.map((issue) => ({
        path: patchIssuePath(issue.path),
        message: issue.message,
      })),
    });
  // The task moved on since the proposal: the proposal is withdrawn and the
  // task stays as it is. That is an outcome to keep, not a refusal, so the
  // operation succeeds with `task: null` (dated note in the plan, §1.2).
  const stale = staleReason(s.state, proposal);
  if (stale) {
    const changes = decideProposal(s, proposal, 'stale', stale);
    return {
      record: proposal,
      changes,
      proposal,
      task: null,
      reason: `Предложение устарело: ${stale}. Задача не изменена.`,
    };
  }
  // The one cast: `parse` of a name picked at runtime cannot tell `tsc` that
  // the payload belongs to that same name.
  const result = runProposedCommand(s, {
    command: command.command,
    payload: commandPayloadSchemas[command.command].parse(command.payload),
  } as ProposalTaskCommand);
  const task = result.record as Task;
  const changes = decideProposal(s, proposal, 'accepted', null, {
    patch: p.patch ?? null,
    resultTaskId: task.id,
  });
  return {
    record: proposal,
    changes,
    proposal,
    task,
    ...(result.confirmedOwnerFields
      ? { confirmedOwnerFields: result.confirmedOwnerFields }
      : {}),
  };
}
function applyProposalReject(
  s: Session,
  p: CommandOf<'proposal.reject'>['payload'],
): CommandResult {
  const proposal = findProposal(s.state, p.ref);
  if (proposal.status !== 'shown' && proposal.status !== 'queued')
    fail('conflict', closedMessage(proposal.status), { current: proposal });
  const changes = decideProposal(s, proposal, 'rejected', p.reason ?? null);
  return { record: proposal, changes, proposal };
}
// The night shift creates and shows (scope propose and up); an agent with
// tasks or write, or the owner, accepts and rejects.
function applyProposal(
  s: Session,
  command: CommandOf<
    | 'proposal.create'
    | 'proposal.deliver'
    | 'proposal.accept'
    | 'proposal.reject'
  >,
): CommandResult {
  switch (command.command) {
    case 'proposal.create':
      requirePropose(s.ctx.actor);
      return applyProposalCreate(s, command.payload);
    case 'proposal.deliver':
      requirePropose(s.ctx.actor);
      return applyProposalDeliver(s, command.payload);
    case 'proposal.accept':
      requireScope(s.ctx.actor, 'proposal');
      return applyProposalAccept(s, command.payload);
    case 'proposal.reject':
      requireScope(s.ctx.actor, 'proposal');
      return applyProposalReject(s, command.payload);
    default:
      return assertNever(command);
  }
}
// The caller validates: the server through commandEnvelopeSchema in
// operations.ts, the web client through typed builders. `command.command`
// is exhaustive here, so a new payload schema without a branch fails `tsc`.
export function applyCommand(
  input: WorkspaceState,
  command: Command,
  ctx: CommandContext,
): CommandApplication {
  const effects: ChangeEffect[] = [];
  const s: Session = {
    state: structuredClone(input),
    ctx,
    history: Array.isArray(ctx.history)
      ? arrayHistory(ctx.history)
      : (ctx.history ?? arrayHistory([])),
    effects,
    name: command.command,
    emit(kind, before, after, cmd = command.command) {
      let changes = changesBetween(before, after);
      if (hasOwnerFields(after) && ctx.actor.kind === 'owner') {
        after.ownerTouchedAt ??= ctx.now;
        // Writing a step is deciding its wording, place and existence, not
        // its tick or outcome: those stay open to whoever executes it.
        const decided = Object.keys(changes).filter(
          (k) =>
            isSubjectField(kind, k) &&
            !(kind === 'step' && !before && STEP_EXECUTION_FIELDS.has(k)),
        );
        after.ownerFields = [
          ...new Set([...after.ownerFields, ...decided]),
        ].toSorted();
        changes = changesBetween(before, after);
      }
      if (Object.keys(changes).length === 0) return changes;
      after.revision = (before?.revision ?? 0) + 1;
      if ('updatedAt' in after) after.updatedAt = ctx.now;
      effects.push({
        entityKind: kind,
        entityId: after.id,
        // A comment or a step belongs to its task's history; a proposal is
        // not the task's record and stays out of it.
        ...(isComment(after) || isStep(after) ? { taskId: after.taskId } : {}),
        command: cmd,
        changes,
        recordRevision: after.revision,
      });
      if (isStep(after)) refreshChecklist(s.state, after.taskId);
      return changes;
    },
  };
  if (ctx.actor.scope === 'propose' && !PROPOSE_COMMANDS.has(command.command))
    fail(
      'forbidden',
      'Ключ propose только предлагает: доступны proposal create и proposal deliver.',
    );
  let result: CommandResult;
  switch (command.command) {
    case 'proposal.create':
    case 'proposal.deliver':
    case 'proposal.accept':
    case 'proposal.reject':
      result = applyProposal(s, command);
      break;
    case 'undo':
      result = applyUndo(s, command.payload);
      break;
    case 'project.create':
      requireScope(ctx.actor, 'project');
      result = applyProjectCreate(s, command.payload);
      break;
    case 'project.update':
      requireScope(ctx.actor, 'project');
      result = applyProjectUpdate(s, command.payload);
      break;
    case 'label.create':
      requireScope(ctx.actor, 'label');
      result = applyLabelCreate(s, command.payload);
      break;
    case 'label.update':
      requireScope(ctx.actor, 'label');
      result = applyLabelUpdate(s, command.payload);
      break;
    case 'label.archive':
      requireScope(ctx.actor, 'label');
      result = applyLabelArchive(s, command.payload, true);
      break;
    case 'label.restore':
      requireScope(ctx.actor, 'label');
      result = applyLabelArchive(s, command.payload, false);
      break;
    case 'comment.add':
      requireScope(ctx.actor, 'comment');
      result = applyCommentAdd(s, command.payload);
      break;
    case 'comment.remove':
      requireScope(ctx.actor, 'comment');
      result = applyCommentRemove(s, command.payload);
      break;
    case 'appearance.update':
      requireScope(ctx.actor, 'appearance');
      result = applyAppearanceUpdate(s, command.payload);
      break;
    case 'task.create':
      requireScope(ctx.actor, 'task');
      result = applyTaskCreate(s, command.payload);
      break;
    case 'task.sync':
      requireScope(ctx.actor, 'task');
      result = applyTaskSync(s, command.payload);
      break;
    case 'task.update':
    case 'task.save':
    case 'task.move':
    case 'task.archive':
    case 'task.restore':
      requireScope(ctx.actor, 'task');
      result = applyTaskWrite(s, command);
      break;
    case 'checklist.add':
    case 'checklist.update':
    case 'checklist.remove':
    case 'checklist.move':
    case 'checklist.reorder':
    case 'checklist.promote':
      requireScope(ctx.actor, 'step');
      result = applyChecklist(s, command);
      break;
    default:
      return assertNever(command);
  }
  assertInvariants(s.state, new Set(effects.map((e) => e.entityId)));
  return { state: s.state, result, effects };
}
export function applyEvent(
  input: WorkspaceState,
  event: Pick<
    DomainEvent,
    'entityKind' | 'entityId' | 'taskId' | 'changes' | 'recordRevision' | 'at'
  >,
): WorkspaceState {
  // Replay is immutable, but an unrelated record must retain its identity:
  // web subscribers use that identity to skip unchanged task cards (TI-083).
  const state = {
    ...input,
    [ENTITIES[event.entityKind].collection]: [
      ...records(input, event.entityKind),
    ],
  };
  const list = records(state, event.entityKind);
  const index = list.findIndex((r) => r.id === event.entityId);
  const prior = index < 0 ? undefined : list[index];
  const patch = Object.fromEntries(
    Object.entries(event.changes).map(([k, v]) => [k, v.to]),
  );
  // A task event written before steps were records (0008) carries the
  // whole checklist: it stands for the step rows the migration made of it.
  const legacy =
    event.entityKind === 'task' && 'checklist' in patch
      ? legacyChecklistItems(patch.checklist)
      : null;
  delete patch.checklist;
  if (event.entityKind === 'comment') {
    const taskId =
      event.taskId ??
      (patch.taskId as string | undefined) ??
      (prior && isComment(prior) ? prior.taskId : undefined);
    const taskIndex = state.tasks.findIndex((t) => t.id === taskId);
    const task = state.tasks[taskIndex];
    const creation = event.changes.createdAt?.from === null;
    const deletion = event.changes.deletedAt;
    const delta = creation
      ? patch.deletedAt
        ? 0
        : 1
      : deletion
        ? Number(!deletion.to) - Number(!deletion.from)
        : 0;
    if (task && delta) {
      state.tasks = [...state.tasks];
      state.tasks[taskIndex] = {
        ...task,
        commentCount: task.commentCount + delta,
      };
    }
  }
  if (prior || event.changes.createdAt?.from === null) {
    // Replay trusts the journal: the record is rebuilt from its changes.
    const next = {
      ...prior,
      ...patch,
      id: event.entityId,
      revision: event.recordRevision,
      ...(event.entityKind !== 'comment' ? { updatedAt: event.at } : {}),
    } as Entity;
    // A task event never carries the derived fields (checklist, comment
    // count): a created task starts them here, with the schema defaults of
    // fields older journals do not name.
    if (event.entityKind === 'task') {
      const task = next as Task;
      if (!prior) {
        task.commentCount = 0;
        task.priority ??= DEFAULT_PRIORITY;
        task.labels ??= [];
        task.closes ??= null;
        task.checklist = projectChecklist(state.steps, task.id);
      }
      // A label the catalogue never had (retired before 0007) vanishes on
      // replay, exactly as its migration dropped it from the tables; the
      // journal and stored results keep it as written.
      task.labels = task.labels.filter((id) =>
        state.labels.some((l) => l.id === id),
      );
      // Before 0008 the owner's touch on any step marked `checklist` on the
      // task; the migration dropped that entry, steps carry their own now.
      task.ownerFields = task.ownerFields.filter((k) => k !== 'checklist');
    }
    if (index < 0) list.push(next);
    else list[index] = next;
  }
  if (legacy) {
    const task = state.tasks.find((t) => t.id === event.entityId);
    if (task) {
      state.steps = [
        ...state.steps.filter((x) => x.taskId !== task.id),
        ...legacySteps(task, legacy),
      ];
      replaceTask(state, {
        ...task,
        checklist: projectChecklist(state.steps, task.id),
      });
    }
  }
  if (event.entityKind === 'step') {
    const step = list.find((r) => r.id === event.entityId);
    const taskId =
      event.taskId ??
      (patch.taskId as string | undefined) ??
      (step && isStep(step) ? step.taskId : undefined);
    const task = state.tasks.find((t) => t.id === taskId);
    if (task)
      replaceTask(state, {
        ...task,
        checklist: projectChecklist(state.steps, task.id),
      });
  }
  return state;
}
// A new task object in a new array, so subscribers of other tasks keep their
// identities (TI-083).
function replaceTask(state: WorkspaceState, task: Task) {
  state.tasks = state.tasks.map((t) => (t.id === task.id ? task : t));
}
