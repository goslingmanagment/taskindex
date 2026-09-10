import { generateKeyBetween } from 'fractional-indexing';
import type {
  Actor,
  Changes,
  Command,
  CommandResult,
  DomainEvent,
  Entity,
  EntityKind,
  WorkspaceState,
  Task,
  Project,
  Comment,
  ChecklistItem,
} from './model.js';
import { byOrder } from './queries.js';
import { fail } from './errors.js';
import { parseCommand, checklistSchema, z } from './schemas.js';
export type ChangeEffect = {
  entityKind: EntityKind;
  entityId: string;
  taskId?: string;
  command: string;
  changes: Changes;
  recordRevision: number;
};
export type CommandContext = {
  now: string;
  ids: () => string;
  actor: Actor;
  history?: DomainEvent[];
  operationId?: string;
};
export type CommandApplication = {
  state: WorkspaceState;
  result: CommandResult;
  effects: ChangeEffect[];
};
const taskFields = new Set([
  'area',
  'projectId',
  'title',
  'status',
  'note',
  'due',
  'waitingFor',
  'followUp',
  'orderKey',
  'focus',
  'archived',
  'checklist',
  'originUrl',
]);
const projectFields = new Set(['name', 'color', 'description']);
export function isSubjectField(kind: EntityKind, key: string): boolean {
  return kind === 'task'
    ? taskFields.has(key)
    : kind === 'project'
      ? projectFields.has(key)
      : key === 'deletedAt';
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const object = (v: unknown) => v as Record<string, unknown>;
export function requireScope(actor: Actor, kind: EntityKind) {
  if (actor.scope === 'read' || (kind === 'project' && actor.scope !== 'write'))
    fail('forbidden', 'У ключа недостаточно прав.');
}
export function compareOriginVersion(a: string, b: string): number | null {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a),
      y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
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
    const x = left.fraction.padEnd(width, '0'),
      y = right.fraction.padEnd(width, '0');
    return x < y ? -1 : x > y ? 1 : 0;
  }

  return null;
}
function changesBetween(before: Entity | undefined, after: Entity): Changes {
  const a = before ? object(before) : {};
  const b = object(after);
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
function records(state: WorkspaceState, kind: EntityKind): Entity[] {
  return kind === 'task'
    ? state.tasks
    : kind === 'project'
      ? state.projects
      : state.comments;
}
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
  history: DomainEvent[],
) {
  if (base > record.revision) fail('invalid', 'Базовая версия из будущего.');
  if (base < record.revision) {
    const changed = new Set(
      history
        .filter(
          (e) =>
            e.entityKind === kind &&
            e.entityId === record.id &&
            e.recordRevision > base,
        )
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
function order(
  state: WorkspaceState,
  task: Task,
  position?: { before?: string; after?: string },
) {
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
export function assertInvariants(state: WorkspaceState) {
  const names = new Set<string>(),
    keys = new Set<string>(),
    origins = new Set<string>(),
    itemIds = new Set<string>();
  for (const p of state.projects) {
    const name = `${p.area}/${p.name.toLocaleLowerCase('ru').trim()}`;
    if (names.has(name))
      fail('conflict', 'Проект с таким именем уже существует.', { current: p });
    names.add(name);
  }
  for (const t of state.tasks) {
    if (
      t.projectId &&
      state.projects.find((p) => p.id === t.projectId)?.area !== t.area
    )
      fail('invalid', 'Проект должен принадлежать области задачи.');
    const key = `${t.area}/${t.status}/${t.orderKey}`;
    if (keys.has(key))
      fail('conflict', 'Прежнее место задачи уже занято.', {
        current: t,
        conflicts: [
          { entityKind: 'task', entityId: t.id, fields: ['orderKey'] },
        ],
      });
    keys.add(key);
    if (
      Boolean(t.originSystem) !== Boolean(t.originRef) ||
      (!t.originSystem && t.originUrl)
    )
      fail('invalid', 'Укажите систему и идентификатор источника вместе.');
    if (t.originSystem) {
      const origin = JSON.stringify([t.originSystem, t.originRef]);
      if (origins.has(origin))
        fail('conflict', 'Задача этого источника уже существует.', {
          current: t,
        });
      origins.add(origin);
    }
    checklistSchema.parse(t.checklist);
    for (const item of t.checklist) {
      if (itemIds.has(item.id))
        fail('invalid', 'Идентификатор шага уже занят другой задачей.');
      itemIds.add(item.id);
    }
  }
}
export function applyCommand(
  input: WorkspaceState,
  raw: Command,
  ctx: CommandContext,
): CommandApplication {
  const command = parseCommand(raw);
  const p = command.payload as Record<string, unknown>;
  const name = command.command;
  const state = structuredClone(input);
  const effects: ChangeEffect[] = [];
  const history = ctx.history ?? [];
  let result: CommandResult = { record: null, changes: {} };
  const emit = (
    kind: EntityKind,
    before: Entity | undefined,
    after: Entity,
    cmd: string = name,
  ) => {
    let changes = changesBetween(before, after);
    if (kind === 'task' && ctx.actor.kind === 'owner') {
      const t = after as Task;
      t.ownerTouchedAt ??= ctx.now;
      t.ownerFields = [
        ...new Set([
          ...t.ownerFields,
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
      ...(kind === 'comment' ? { taskId: (after as Comment).taskId } : {}),
      command: cmd,
      changes,
      recordRevision: after.revision,
    });
    return changes;
  };
  if (name === 'undo') {
    const target = history.filter((e) =>
      p.seq !== undefined ? e.seq === p.seq : e.operationId === p.operationId,
    );
    if (!target.length)
      fail('not_undoable', 'У операции нет отменяемых событий.');
    if (target.some((e) => e.command === 'project.create'))
      fail('not_undoable', 'Создание проекта не отменяется.');
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
    const inverses: {
      kind: EntityKind;
      record: Entity;
      values: Record<string, unknown>;
      base: number;
      keys: string[];
    }[] = [];
    for (const events of groups.values()) {
      events.sort((a, b) => a.seq - b.seq);
      const first = events[0]!;
      const kind = first.entityKind;
      const record = get(state, kind, first.entityId);
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
        values =
          kind === 'task'
            ? (record as Task).archived
              ? {}
              : { archived: true }
            : kind === 'comment'
              ? (record as Comment).deletedAt
                ? {}
                : { deletedAt: ctx.now }
              : {};
      } else
        values = Object.fromEntries(
          Object.entries(net)
            .filter(([, v]) => !equal(v.from, v.to))
            .map(([k, v]) => [k, v.from]),
        );
      if (!created && !Object.keys(values).length) continue;
      requireScope(ctx.actor, kind);
      if (
        kind === 'comment' &&
        ctx.actor.kind !== 'owner' &&
        (record as Comment).actorId !== ctx.actor.id
      )
        fail('forbidden', 'Нельзя отменить чужой комментарий.');
      const keys = created
        ? Object.keys(object(record)).filter((k) => isSubjectField(kind, k))
        : Object.keys(values);
      const later = history.filter(
        (e) =>
          e.entityKind === kind &&
          e.entityId === record.id &&
          e.recordRevision > last.recordRevision &&
          !target.includes(e),
      );
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
    for (const inverse of inverses) {
      const before = structuredClone(inverse.record);
      Object.assign(inverse.record, inverse.values);
      const changes = emit(inverse.kind, before, inverse.record);
      if (inverse.kind === 'comment') {
        const c = inverse.record as Comment;
        const task = get(state, 'task', c.taskId) as Task;
        task.commentCount +=
          Number(!c.deletedAt) - Number(!(before as Comment).deletedAt);
      }
      changed.push(inverse.record);
      if (inverses.length === 1) result = { record: inverse.record, changes };
    }
    if (inverses.length > 1)
      result = { record: null, records: changed, changes: {} };
  } else if (name.startsWith('project.')) {
    requireScope(ctx.actor, 'project');
    if (name === 'project.create') {
      const id = (p.id as string | undefined) ?? ctx.ids();
      if (state.projects.some((r) => r.id === id))
        fail('conflict', 'Идентификатор проекта уже занят.');
      const record: Project = {
        id,
        area: p.area as Project['area'],
        name: p.name as string,
        color: (p.color as string).toLowerCase(),
        description: (p.description as string | undefined) ?? '',
        revision: 0,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      state.projects.push(record);
      result = { record, changes: emit('project', undefined, record) };
    } else {
      const record = get(state, 'project', p.id as string) as Project;
      const before = structuredClone(record);
      const patch = Object.fromEntries(
        Object.entries(p).filter(([k]) => projectFields.has(k)),
      );
      assertMerge(
        'project',
        record,
        p.baseRevision as number,
        Object.keys(patch),
        history,
      );
      Object.assign(record, patch);
      record.color = record.color.toLowerCase();
      result = { record, changes: emit('project', before, record) };
    }
  } else if (name.startsWith('comment.')) {
    requireScope(ctx.actor, 'comment');
    if (name === 'comment.add') {
      const task = get(state, 'task', p.taskId as string) as Task;
      const id = (p.id as string | undefined) ?? ctx.ids();
      if (state.comments.some((c) => c.id === id))
        fail('conflict', 'Идентификатор комментария уже занят.');
      const record: Comment = {
        id,
        taskId: task.id,
        actorId: ctx.actor.id,
        actorLabel: ctx.actor.label,
        text: p.text as string,
        revision: 0,
        createdAt: ctx.now,
        deletedAt: null,
      };
      state.comments.push(record);
      task.commentCount++;
      result = { record, changes: emit('comment', undefined, record) };
    } else {
      const record = get(state, 'comment', p.commentId as string) as Comment;
      if (ctx.actor.kind !== 'owner' && record.actorId !== ctx.actor.id)
        fail('forbidden', 'Нельзя удалить чужой комментарий.');
      const before = structuredClone(record);
      if (!record.deletedAt) {
        record.deletedAt = ctx.now;
        (get(state, 'task', record.taskId) as Task).commentCount--;
      }
      result = { record, changes: emit('comment', before, record) };
    }
  } else {
    requireScope(ctx.actor, 'task');
    let payload = p;
    const syncing = name === 'task.sync';
    const origin = (p.origin ?? {}) as {
      system?: string;
      ref?: string;
      url?: string;
      version?: string;
    };
    const existing =
      (syncing || name === 'task.create') && origin.system
        ? state.tasks.find(
            (t) =>
              t.originSystem === origin.system && t.originRef === origin.ref,
          )
        : undefined;
    if (name === 'task.create' && existing)
      return {
        state,
        result: { record: existing, changes: {}, existing: true },
        effects,
      };
    if (syncing) payload = p.fields as Record<string, unknown>;
    if (name === 'task.create' || (syncing && !existing)) {
      if (
        origin.version &&
        compareOriginVersion(origin.version, origin.version) === null
      )
        fail(
          'invalid',
          'Версия источника должна задавать порядок его состояний.',
        );
      const id = (payload.id as string | undefined) ?? ctx.ids();
      if (state.tasks.some((t) => t.id === id))
        fail('conflict', 'Идентификатор задачи уже занят.');
      const record: Task = {
        id,
        area: payload.area as Task['area'],
        projectId: (payload.projectId as string | null | undefined) ?? null,
        title: payload.title as string,
        status: (payload.status as Task['status']) ?? 'todo',
        note: (payload.note as string) ?? '',
        due: (payload.due as string | null) ?? null,
        waitingFor: (payload.waitingFor as string) ?? '',
        followUp: (payload.followUp as string | null) ?? null,
        orderKey: '',
        focus: (payload.focus as boolean) ?? false,
        archived: false,
        checklist: (payload.checklist as ChecklistItem[]) ?? [],
        commentCount: 0,
        originSystem: origin.system ?? null,
        originRef: origin.ref ?? null,
        originUrl: origin.url ?? null,
        originVersion: origin.version ?? null,
        createdBy: ctx.actor.id,
        createdByLabel: ctx.actor.label,
        ownerTouchedAt: null,
        ownerFields: [],
        revision: 0,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      record.orderKey = order(
        state,
        record,
        payload.position as { before?: string; after?: string } | undefined,
      );
      state.tasks.push(record);
      result = {
        record,
        changes: emit('task', undefined, record),
        ...(syncing ? { applied: Object.keys(payload), skipped: [] } : {}),
      };
    } else {
      const record =
        existing ??
        (get(
          state,
          'task',
          (name.startsWith('checklist.') ? p.taskId : p.id) as string,
        ) as Task);
      const before = structuredClone(record);
      let patch: Record<string, unknown> = {};
      let position: { before?: string; after?: string } | undefined;
      if (syncing) {
        let reason: string | undefined;
        if (!origin.version || !record.originVersion)
          reason = 'freshness_unknown';
        else {
          const comparison = compareOriginVersion(
            origin.version,
            record.originVersion,
          );
          reason =
            comparison === null
              ? 'version_incomparable'
              : comparison <= 0
                ? 'stale'
                : undefined;
        }
        if (reason)
          return {
            state,
            result: { record, changes: {}, skipped: 'all', reason },
            effects,
          };
        const skipped: { field: string; reason: string }[] = [];
        for (const [key, value] of Object.entries(payload)) {
          if (
            record.ownerTouchedAt &&
            (record.ownerFields.includes(key) ||
              ['status', 'archived', 'focus', 'projectId', 'area'].includes(
                key,
              ))
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
        result = { record, changes: {}, applied: Object.keys(patch), skipped };
      } else if (name === 'task.update') {
        patch = Object.fromEntries(
          Object.entries(p).filter(([k]) => taskFields.has(k)),
        );
      } else if (name === 'task.save') {
        patch = {
          ...object(p.fields ?? {}),
          ...(p.status !== undefined ? { status: p.status } : {}),
          ...(p.checklist !== undefined ? { checklist: p.checklist } : {}),
        };
        position = p.position as typeof position;
      } else if (name === 'task.move') {
        patch = { status: p.status };
        if (p.before || p.after)
          position = {
            before: p.before as string | undefined,
            after: p.after as string | undefined,
          };
      } else if (name === 'task.archive' || name === 'task.restore')
        patch = { archived: name === 'task.archive' };
      else {
        const items = structuredClone(record.checklist);
        const index = items.findIndex((i) => i.id === p.itemId);
        if (name === 'checklist.add')
          items.splice((p.position as number | undefined) ?? items.length, 0, {
            id: (p.id as string | undefined) ?? ctx.ids(),
            text: p.text as string,
            done: false,
          });
        else if (name === 'checklist.reorder') {
          const ids = p.itemIds as string[];
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
        } else {
          if (index < 0) fail('not_found', 'Шаг не найден.');
          if (name === 'checklist.remove') items.splice(index, 1);
          else
            Object.assign(
              items[index]!,
              Object.fromEntries(
                Object.entries(p).filter(([k]) => ['text', 'done'].includes(k)),
              ),
            );
        }
        patch = { checklist: items };
      }
      const moves =
        position !== undefined ||
        name === 'task.move' ||
        (patch.area !== undefined && patch.area !== record.area) ||
        (patch.status !== undefined && patch.status !== record.status);
      if (!syncing)
        assertMerge(
          'task',
          record,
          p.baseRevision as number,
          [...Object.keys(patch), ...(moves ? ['orderKey'] : [])],
          history,
        );
      Object.assign(record, patch);
      if (moves) record.orderKey = order(state, record, position);
      result = { ...result, record, changes: emit('task', before, record) };
    }
  }
  assertInvariants(state);
  return { state, result, effects };
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
      (prior as Comment | undefined)?.taskId;
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
    const next = {
      ...prior,
      ...patch,
      id: event.entityId,
      revision: event.recordRevision,
      ...(event.entityKind !== 'comment' ? { updatedAt: event.at } : {}),
    } as Entity;
    if (event.entityKind === 'task' && !prior) (next as Task).commentCount = 0;
    if (index < 0) list.push(next);
    else list[index] = next;
  }
  return state;
}
