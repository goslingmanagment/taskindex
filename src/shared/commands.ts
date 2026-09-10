import { generateKeyBetween } from 'fractional-indexing';
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
} from './model.js';
import { byFocusKey, byOrder } from './queries.js';
import type { FocusPosition } from './schemas.js';
import { assertNever, fail } from './errors.js';
import { LIMITS } from './limits.js';
import { DEFAULT_APPEARANCE_ID } from './appearance.js';
import { ENTITIES } from './entities.js';
export type ChangeEffect = {
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
export function arrayHistory(events: DomainEvent[]): HistoryAccess {
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
export type CommandContext = {
  now: string;
  ids: () => string;
  actor: Actor;
  history?: DomainEvent[] | HistoryAccess;
  operationId?: string;
  // Envelope flag: the agent acknowledges it is changing owner decisions.
  confirmOwnerFields?: boolean;
};
// Owner-only fields: agents cannot set them directly; task.sync skips them.
const ownerOnlyFields = ['focus', 'focusPosition'] as const;
// Fields the source never overwrites once the owner touched the task.
const ownerLockedFields = ['status', 'archived', 'focus', 'projectId', 'area'];
export type CommandApplication = {
  state: WorkspaceState;
  result: CommandResult;
  effects: ChangeEffect[];
};
// The record kinds, their collections and their subject fields come from the
// shared registry (Ж11). `taskFields` and `projectFields` stay exported for
// the independent oracle in tests/property/undo.test.ts.
export const taskFields = ENTITIES.task.subjectFields;
export const projectFields = ENTITIES.project.subjectFields;
export const appearanceFields = ENTITIES.appearance.subjectFields;
export function isSubjectField(kind: EntityKind, key: string): boolean {
  return ENTITIES[kind].subjectFields.has(key);
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
// Records are told apart by shape: only tasks carry a checklist, only
// comments a taskId.
const isTask = (record: Entity): record is Task => 'checklist' in record;
const isComment = (record: Entity): record is Comment => 'taskId' in record;
export function requireScope(actor: Actor, kind: EntityKind) {
  // Appearance is the owner's own preference: no agent scope reaches it, and
  // task.sync never touches it (TI-025).
  if (kind === 'appearance') {
    if (actor.kind !== 'owner')
      fail('forbidden', 'Оформление меняет только владелец.');
    return;
  }
  if (actor.scope === 'read' || (kind === 'project' && actor.scope !== 'write'))
    fail('forbidden', 'У ключа недостаточно прав.');
}
// -1, 0 or 1 for values a comparison operator already orders (BigInt, string).
function sign<T extends bigint | string>(x: T, y: T): number {
  if (x < y) return -1;
  return x > y ? 1 : 0;
}
export function compareOriginVersion(a: string, b: string): number | null {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return sign(BigInt(a), BigInt(b));
  const instant = (value: string) => {
    if (!z.iso.datetime({ offset: true }).safeParse(value).success) return null;
    const parts =
      /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    return parts
      ? {
          seconds: Date.parse(`${parts[1]}${parts[3]}`),
          fraction: parts[2] ?? '',
        }
      : null;
  };
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
          !['revision', 'updatedAt', 'commentCount'].includes(k) &&
          (!before || !equal(a[k], b[k])),
      )
      .map((k) => [k, { from: before ? a[k] : null, to: b[k] }]),
  );
}
function records(state: WorkspaceState, kind: 'task'): Task[];
function records(state: WorkspaceState, kind: 'project'): Project[];
function records(state: WorkspaceState, kind: 'comment'): Comment[];
function records(state: WorkspaceState, kind: 'appearance'): Appearance[];
function records(state: WorkspaceState, kind: EntityKind): Entity[];
function records(state: WorkspaceState, kind: EntityKind): Entity[] {
  return state[ENTITIES[kind].collection];
}
function get(state: WorkspaceState, kind: 'task', id: string): Task;
function get(state: WorkspaceState, kind: 'project', id: string): Project;
function get(state: WorkspaceState, kind: 'comment', id: string): Comment;
function get(state: WorkspaceState, kind: 'appearance', id: string): Appearance;
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
    .sort(byOrder);
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
    .sort(byFocusKey);
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
    origins = new Map<string, Task>(),
    itemIds = new Set<string>();
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
    if (t.checklist.length > LIMITS.checklistItems)
      fail('invalid', `В задаче не больше ${LIMITS.checklistItems} шагов.`);
    if (new Set(t.checklist.map((i) => i.id)).size !== t.checklist.length)
      fail('invalid', 'Идентификаторы шагов в задаче повторяются.');
    for (const item of t.checklist) {
      if (itemIds.has(item.id))
        fail('invalid', 'Идентификатор шага уже занят другой задачей.');
      itemIds.add(item.id);
    }
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
            from: net[key] ? net[key]!.from : change.from,
            to: change.to,
          };
      }
    let values: Record<string, unknown>;
    if (created) {
      // Undoing a creation hides the record instead of deleting history.
      if (isTask(record)) values = record.archived ? {} : { archived: true };
      else if (isComment(record))
        values = record.deletedAt ? {} : { deletedAt: s.ctx.now };
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
function applyAppearanceUpdate(
  s: Session,
  p: CommandOf<'appearance.update'>['payload'],
): CommandResult {
  const record = get(s.state, 'appearance', DEFAULT_APPEARANCE_ID);
  const before = structuredClone(record);
  const patch: Partial<Pick<Appearance, 'mode' | 'skinId'>> = {
    ...(p.mode !== undefined ? { mode: p.mode } : {}),
    ...(p.skinId !== undefined ? { skinId: p.skinId } : {}),
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
    note: fields.note ?? '',
    due: fields.due ?? null,
    waitingFor: fields.waitingFor ?? '',
    followUp: fields.followUp ?? null,
    orderKey: '',
    focus: false,
    focusKey: null,
    focusLeftAt: null,
    archived: false,
    checklist: fields.checklist ?? [],
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
  return { record, changes: s.emit('task', undefined, record) };
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
  const existing = findByOrigin(s.state, origin);
  if (!existing) {
    const record = createTask(s, undefined, fields, origin, undefined);
    return {
      record,
      changes: s.emit('task', undefined, record),
      applied: Object.keys(fields),
      skipped,
    };
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
        record.ownerFields.includes(key) && !equal(patch[key], current[key]),
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
      return commitTaskPatch(
        s,
        record,
        p.baseRevision,
        {
          ...rest,
          ...(status !== undefined ? { status } : {}),
          ...(checklist !== undefined ? { checklist } : {}),
        },
        position,
        false,
        focusPosition,
      );
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
function applyChecklist(
  s: Session,
  command: CommandOf<
    | 'checklist.add'
    | 'checklist.update'
    | 'checklist.remove'
    | 'checklist.reorder'
  >,
): CommandResult {
  const record = get(s.state, 'task', command.payload.taskId);
  const items = structuredClone(record.checklist);
  switch (command.command) {
    case 'checklist.add': {
      const p = command.payload;
      items.splice(p.position ?? items.length, 0, {
        id: p.id ?? s.ctx.ids(),
        text: p.text,
        done: false,
      });
      break;
    }
    case 'checklist.reorder': {
      const ids = command.payload.itemIds;
      if (
        ids.length !== items.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !items.some((i) => i.id === id))
      )
        fail('invalid', 'Укажите все шаги без повторов.');
      items.splice(
        0,
        items.length,
        ...ids.map((id) => items.find((i) => i.id === id)!),
      );
      break;
    }
    case 'checklist.remove':
    case 'checklist.update': {
      const index = items.findIndex((i) => i.id === command.payload.itemId);
      if (index < 0) fail('not_found', 'Шаг не найден.');
      if (command.command === 'checklist.remove') items.splice(index, 1);
      else {
        const { text, done } = command.payload;
        Object.assign(items[index]!, {
          ...(text !== undefined ? { text } : {}),
          ...(done !== undefined ? { done } : {}),
        });
      }
      break;
    }
    default:
      return assertNever(command);
  }
  return commitTaskPatch(
    s,
    record,
    command.payload.baseRevision,
    { checklist: items },
    undefined,
  );
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
      if (isTask(after) && ctx.actor.kind === 'owner') {
        after.ownerTouchedAt ??= ctx.now;
        after.ownerFields = [
          ...new Set([
            ...after.ownerFields,
            ...Object.keys(changes).filter((k) => isSubjectField('task', k)),
          ]),
        ].sort();
        changes = changesBetween(before, after);
      }
      if (Object.keys(changes).length === 0) return changes;
      after.revision = (before?.revision ?? 0) + 1;
      if ('updatedAt' in after) after.updatedAt = ctx.now;
      effects.push({
        entityKind: kind,
        entityId: after.id,
        ...(isComment(after) ? { taskId: after.taskId } : {}),
        command: cmd,
        changes,
        recordRevision: after.revision,
      });
      return changes;
    },
  };
  let result: CommandResult;
  switch (command.command) {
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
    case 'checklist.reorder':
      requireScope(ctx.actor, 'task');
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
  event: DomainEvent,
): WorkspaceState {
  const state = structuredClone(input);
  const list = records(state, event.entityKind);
  const index = list.findIndex((r) => r.id === event.entityId);
  const prior = index < 0 ? undefined : list[index];
  const patch = Object.fromEntries(
    Object.entries(event.changes).map(([k, v]) => [k, v.to]),
  );
  if (event.entityKind === 'comment') {
    const taskId =
      event.taskId ??
      (patch.taskId as string | undefined) ??
      (prior && isComment(prior) ? prior.taskId : undefined);
    const task = state.tasks.find((t) => t.id === taskId);
    const creation = event.changes.createdAt?.from === null;
    const deletion = event.changes.deletedAt;
    if (task) {
      if (creation) task.commentCount += patch.deletedAt ? 0 : 1;
      else if (deletion)
        task.commentCount += Number(!deletion.to) - Number(!deletion.from);
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
    if (event.entityKind === 'task' && !prior && isTask(next))
      next.commentCount = 0;
    if (index < 0) list.push(next);
    else list[index] = next;
  }
  return state;
}
