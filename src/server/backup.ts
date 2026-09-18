import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from './db.js';
import {
  withRead,
  withWrite,
  setSetting,
  generation,
  latestSeq,
  readState,
  readEvents,
  readOperations,
  writeState,
  writeGenerationSidecar,
  assertSchema,
  schemaVersion,
} from './db.js';
import * as schema from './schema.js';
import { FORMAT_VERSION } from '../shared/model.js';
import type { ExportData, Task, WorkspaceState } from '../shared/model.js';
import { assertInvariants, applyEvent } from '../shared/commands.js';
import { SEEDED_LABELS } from '../shared/labels.js';
import { canonicalJson } from '../shared/canonical-json.js';
import { fail } from '../shared/errors.js';
import { RESERVED_IDS } from '../shared/schemas.js';
import { compareStrings } from '../shared/queries.js';
import { projectChecklist } from '../shared/steps.js';
import { defaultAppearance } from '../shared/domain-schemas.js';
import { upgradeExport } from './export-upgrade.js';
import { DEFAULT_APPEARANCE_ID } from '../shared/appearance.js';
import { ENTITIES } from '../shared/entities.js';
import { listAgents } from './agents.js';

export function exportWorkspace(db: DatabaseHandle): ExportData {
  return withRead(db, (): ExportData => {
    const state = readState(db);
    return {
      formatVersion: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      generation: generation(db),
      seq: latestSeq(db),
      settings: Object.fromEntries(
        db.orm
          .select()
          .from(schema.settings)
          .all()
          .filter((s) => s.key !== 'approved_deployment')
          .map((s) => [s.key, s.value]),
      ),
      ...state,
      agents: listAgents(db),
      events: readEvents(db),
      operations: readOperations(db),
    };
  });
}
const invalid = (message: string): never =>
  fail('invalid', `Повреждённый экспорт: ${message}`);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sorted = <T extends { id: string }>(rows: T[]) =>
  rows.toSorted((a, b) => compareStrings(a.id, b.id));
const withoutGeneration = (rows: { generation: string }[]) =>
  rows.map(({ generation: _generation, ...event }) => event);
export function validateExport(data: ExportData) {
  for (const rows of [
    data.tasks,
    data.projects,
    data.labels,
    data.steps,
    data.comments,
    data.agents,
    data.operations,
  ])
    if (new Set(rows.map((r) => r.id)).size !== rows.length)
      invalid('повторяющиеся идентификаторы.');
  // Journal positions are dense: assigned as MAX + 1 in the writing
  // transaction and never deleted, so an export holds exactly 1..N.
  const positions = data.operations
    .map((o) => o.operationSeq)
    .toSorted((a, b) => a - b);
  if (positions.some((position, index) => position !== index + 1))
    invalid('позиции операций не образуют непрерывную последовательность.');
  // A task's checklist is the projection of its live step records (0008).
  for (const t of data.tasks)
    if (!same(t.checklist, projectChecklist(data.steps, t.id)))
      invalid('шаги задачи не совпадают с таблицей шагов.');
  if (
    data.appearance.length !== 1 ||
    data.appearance[0]!.id !== DEFAULT_APPEARANCE_ID
  )
    invalid('оформление должно быть одной записью owner.');
  if (data.settings.generation !== data.generation)
    invalid('поколение настроек не совпадает с экспортом.');
  if (!data.settings.timezone) invalid('часовой пояс отсутствует.');
  try {
    new Intl.DateTimeFormat('ru', {
      timeZone: data.settings.timezone,
    }).format();
  } catch {
    invalid('неверный часовой пояс.');
  }
  const tasks = new Set(data.tasks.map((t) => t.id));
  for (const c of data.comments)
    if (!tasks.has(c.taskId))
      invalid('комментарий ссылается на отсутствующую задачу.');
  for (const s of data.steps)
    if (!tasks.has(s.taskId)) invalid('шаг ссылается на отсутствующую задачу.');
  if (
    data.seq !== data.events.length ||
    data.events.some(
      (e, i) => e.seq !== i + 1 || e.generation !== data.generation,
    )
  )
    invalid('нарушена непрерывная последовательность событий.');
  const operations = new Map(data.operations.map((o) => [o.id, o]));
  const byOperation = new Map<string, typeof data.events>();
  // 0007 seeds the label catalogue in SQL, so the journal starts with these
  // five records (data rule variant b); every later change is an event.
  let replay: WorkspaceState = {
    projects: [],
    labels: structuredClone(SEEDED_LABELS),
    tasks: [],
    steps: [],
    comments: [],
    appearance: [defaultAppearance()],
  };
  // A task event of the journal written before 0008 carries the checklist
  // as the rows of that time; the replayed task shows the projection of the
  // step records those rows became.
  const legacyView = (checklist: unknown) =>
    Array.isArray(checklist)
      ? (checklist as { id: string; text: string; done: boolean }[]).map(
          ({ id, text, done }) => ({ id, text, done }),
        )
      : checklist;
  for (const e of data.events) {
    const op =
      operations.get(e.operationId) ?? invalid('событие без операции.');
    if (
      e.actorId !== op.actorId ||
      e.actorLabel !== op.actorLabel ||
      e.firstSeq !== op.firstSeq ||
      e.lastSeq !== op.lastSeq ||
      e.seq < e.firstSeq ||
      e.seq > e.lastSeq
    )
      invalid('границы или актор события не совпадают с операцией.');
    const list: { id: string; revision: number }[] =
      replay[ENTITIES[e.entityKind].collection];
    const before = list.find((r) => r.id === e.entityId);
    if (e.recordRevision !== (before?.revision ?? 0) + 1)
      invalid('нарушена версия записи.');
    for (const [key, change] of Object.entries(e.changes)) {
      const stored = before
        ? (before as unknown as Record<string, unknown>)[key]
        : null;
      // 0006: the journal still names a retired label; replay reads it
      // through the catalogue (applyEvent), so does this comparison. 0008:
      // the owner's `checklist` entry left tasks.owner_fields the same way.
      const from =
        e.entityKind === 'task' && Array.isArray(change.from)
          ? key === 'labels'
            ? change.from.filter((id) =>
                replay.labels.some((label) => label.id === id),
              )
            : key === 'ownerFields'
              ? change.from.filter((field) => field !== 'checklist')
              : change.from
          : change.from;
      if (
        !same(
          from,
          e.entityKind === 'task' && key === 'checklist'
            ? legacyView(stored)
            : stored,
        )
      )
        invalid('история изменений не соответствует предыдущему состоянию.');
    }
    if (
      (e.entityKind === 'comment' || e.entityKind === 'step') &&
      (e.taskId ?? e.changes.taskId?.to) !==
        (before && 'taskId' in before ? before.taskId : e.changes.taskId?.to)
    )
      invalid('событие комментария или шага указывает другую задачу.');
    replay = applyEvent(replay, e);
    byOperation.set(op.id, [...(byOperation.get(op.id) ?? []), e]);
  }
  for (const op of data.operations) {
    const events = byOperation.get(op.id) ?? [];
    const first = events[0]?.seq ?? null,
      last = events.at(-1)?.seq ?? null;
    if (
      op.firstSeq !== first ||
      op.lastSeq !== last ||
      (first !== null && last! - first + 1 !== events.length)
    )
      invalid('операция содержит неполный диапазон событий.');
    if (
      op.ok !== op.result.ok ||
      op.errorCode !== (op.result.ok ? undefined : op.result.code) ||
      op.errorMessage !== (op.result.ok ? undefined : op.result.message)
    )
      invalid('краткий исход не совпадает с ответом операции.');
    if (op.result.operationId !== op.id)
      invalid('ответ относится к другой операции.');
    if (op.result.ok) {
      if (
        op.status !== 200 ||
        op.result.dryRun ||
        op.result.firstSeq !== first ||
        op.result.lastSeq !== last
      )
        invalid('некорректный сохранённый результат операции.');
      if (!same(withoutGeneration(events), withoutGeneration(op.result.events)))
        invalid('события ответа не совпадают с журналом.');
    } else if (events.length || op.status < 400 || op.result.retryable)
      invalid('ошибка операции содержит события или повторяемый исход.');
  }
  // 0004_focus_desk (plan 13, data rule variant b): the tasks that were on
  // the desk when the columns arrived carry a backfilled focusKey no event
  // names. A replayed task the journal never gave a desk key takes the schema
  // default (null) and, when the tables say it is focused, the backfilled
  // key of the tables; a key or a focusLeftAt the journal did write must
  // match exactly.
  const stored = new Map(data.tasks.map((t) => [t.id, t]));
  for (const t of replay.tasks as Partial<
    Pick<Task, 'focusKey' | 'focusLeftAt'>
  >[] &
    Task[]) {
    if (t.focusLeftAt === undefined) t.focusLeftAt = null;
    if (t.focusKey === undefined)
      t.focusKey = t.focus ? (stored.get(t.id)?.focusKey ?? null) : null;
  }
  const normalized = (state: WorkspaceState) => ({
    tasks: sorted(state.tasks),
    projects: sorted(state.projects),
    labels: sorted(state.labels),
    steps: sorted(state.steps),
    comments: sorted(state.comments),
    appearance: sorted(state.appearance),
  });
  if (!same(normalized(replay), normalized(data)))
    invalid('состояние записей не совпадает с журналом событий.');
}
export function importWorkspace(
  db: DatabaseHandle,
  raw: ExportData | Record<string, unknown>,
  options: { replace?: boolean; migrationsDir?: string } = {},
) {
  assertSchema(db, options.migrationsDir);
  const data = upgradeExport(raw);
  const version = schemaVersion(options.migrationsDir);
  const exported = Number(data.settings.schema_version);
  // An export always lands on the current schema: older schema versions are
  // accepted through the format upgrade above, newer ones are not readable.
  if (!Number.isInteger(exported) || exported < 1 || exported > version)
    fail('invalid', 'Формат или схема экспорта не поддерживается.');
  for (const record of [...data.tasks, ...data.projects])
    if (RESERVED_IDS.has(record.id))
      fail(
        'invalid',
        `Служебное слово нельзя использовать как идентификатор: ${record.id}.`,
      );
  assertInvariants(data);
  validateExport(data);
  return withWrite(db, () => {
    if (
      !options.replace &&
      ([
        schema.user,
        schema.session,
        schema.account,
        schema.verification,
        schema.agentKeys,
        schema.passkey,
        schema.agents,
        schema.appearance,
        schema.projects,
        schema.tasks,
        schema.checklistItems,
        schema.comments,
        schema.events,
        schema.operations,
      ].some((table) => db.orm.select().from(table).get()) ||
        db.orm
          .select()
          .from(schema.settings)
          .all()
          .some(
            (s) =>
              !['generation', 'timezone', 'schema_version'].includes(s.key),
          ))
    )
      fail('conflict', 'Импорт разрешён только в пустую базу или с --replace.');
    for (const table of [
      schema.agentKeys,
      schema.passkey,
      schema.session,
      schema.account,
      schema.verification,
      schema.user,
      schema.appearance,
      schema.comments,
      schema.checklistItems,
      schema.tasks,
      schema.projects,
      schema.labels,
      schema.agents,
      schema.events,
      schema.operations,
      schema.settings,
    ])
      db.orm.delete(table).run();
    for (const [key, value] of Object.entries(data.settings))
      if (key !== 'approved_deployment') setSetting(db, key, value);
    setSetting(db, 'schema_version', String(version));
    writeState(db, data);
    for (const a of data.agents) db.orm.insert(schema.agents).values(a).run();
    for (const { generation: _generation, ...e } of data.events)
      db.orm.insert(schema.events).values(e).run();
    for (const {
      taskCount: _taskCount,
      titles: _titles,
      ok: _ok,
      errorCode: _errorCode,
      errorMessage: _errorMessage,
      ...o
    } of data.operations)
      // Imported rows keep the result the export carried, events and all:
      // rebuilding them here would stamp the new generation of the restore on
      // history that was written under the old one (Ж1: old rows read as is).
      db.orm.insert(schema.operations).values(o).run();
    db.sqlite.prepare("DELETE FROM sqlite_sequence WHERE name='events'").run();
    db.sqlite
      .prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('events',?)")
      .run(data.seq);
    return markRestored(db, options.migrationsDir);
  });
}
export function markRestored(db: DatabaseHandle, migrationsDir?: string) {
  assertSchema(db, migrationsDir);
  const next = randomUUID();
  withWrite(db, () => {
    setSetting(db, 'generation', next);
    db.orm
      .delete(schema.settings)
      .where(eq(schema.settings.key, 'approved_deployment'))
      .run();
  });
  writeGenerationSidecar(db);
  return { generation: next, seq: latestSeq(db) };
}
