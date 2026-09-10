import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import type { DatabaseHandle } from './db.js';
import {
  getSetting,
  setSetting,
  generation,
  latestSeq,
  readState,
  readEvents,
  readOperations,
  writeState,
  migrate,
  assertSchema,
  schemaVersion,
} from './db.js';
import * as schema from './schema.js';
import { issueAgentKey } from './agent-keys.js';
import { FORMAT_VERSION } from '../shared/model.js';
import type { ExportData, Scope, WorkspaceState } from '../shared/model.js';
import { assertInvariants, applyEvent } from '../shared/commands.js';
import { canonicalJson } from '../shared/canonical-json.js';
import { fail } from '../shared/errors.js';
import { idSchema, RESERVED_IDS, z } from '../shared/schemas.js';
import { compareStrings } from '../shared/queries.js';
import { exportSchema, exportSchemaV1 } from '../shared/domain-schemas.js';
import { LIMITS } from '../shared/limits.js';
export { migrate } from './db.js';
export function initialize(
  db: DatabaseHandle,
  options: { timezone?: string; migrationsDir?: string } = {},
) {
  migrate(db, options);
  return {
    generation: generation(db),
    schemaVersion: schemaVersion(options.migrationsDir),
  };
}
export async function createOwner(
  db: DatabaseHandle,
  input: { email: string; password: string; name?: string },
) {
  z.email().parse(input.email);
  z.string().min(8).max(128).parse(input.password);
  const password = await hashPassword(input.password);
  return db.sqlite
    .transaction(() => {
      if (db.orm.select().from(schema.user).get())
        fail('conflict', 'Владелец уже существует.');
      const now = new Date();
      const row = {
        id: 'owner',
        name: input.name ?? 'Владелец',
        email: input.email.toLowerCase(),
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      };
      db.orm.insert(schema.user).values(row).run();
      db.orm
        .insert(schema.account)
        .values({
          id: randomUUID(),
          accountId: 'owner',
          providerId: 'credential',
          userId: 'owner',
          password,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return { id: row.id, email: row.email, name: row.name };
    })
    .immediate();
}
export async function resetOwnerPassword(
  db: DatabaseHandle,
  input: { password: string },
) {
  z.string().min(8).max(128).parse(input.password);
  const password = await hashPassword(input.password);
  return db.sqlite
    .transaction(() => {
      const owner = db.orm
        .select()
        .from(schema.user)
        .where(eq(schema.user.id, 'owner'))
        .get();
      if (!owner) fail('not_found', 'Владелец не создан.');
      const account = db.orm
        .select()
        .from(schema.account)
        .where(eq(schema.account.userId, 'owner'))
        .all()
        .find((a) => a.providerId === 'credential');
      if (!account) fail('not_found', 'Пароль владельца не настроен.');
      db.orm
        .update(schema.account)
        .set({ password, updatedAt: new Date() })
        .where(eq(schema.account.id, account.id))
        .run();
      db.orm
        .delete(schema.session)
        .where(eq(schema.session.userId, 'owner'))
        .run();
      return { ok: true };
    })
    .immediate();
}
export function createAgent(
  db: DatabaseHandle,
  input: { id: string; label: string },
) {
  idSchema.parse(input.id);
  z.string().trim().min(1).max(LIMITS.agentLabel).parse(input.label);
  if (
    db.orm
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, input.id))
      .get()
  )
    fail('conflict', 'Агент с таким id уже существует.');
  const row = {
    id: input.id,
    label: input.label.trim(),
    createdAt: new Date().toISOString(),
    disabledAt: null,
  };
  db.orm.insert(schema.agents).values(row).run();
  return row;
}
export function listAgents(db: DatabaseHandle) {
  return db.orm.select().from(schema.agents).all();
}
export function disableAgent(db: DatabaseHandle, id: string) {
  if (
    !db.orm.select().from(schema.agents).where(eq(schema.agents.id, id)).get()
  )
    fail('not_found', 'Агент не найден.');
  db.orm
    .update(schema.agents)
    .set({ disabledAt: new Date().toISOString() })
    .where(eq(schema.agents.id, id))
    .run();
  return { ok: true };
}
export function createAgentKey(
  db: DatabaseHandle,
  input: { agentId: string; scope: Scope; name?: string },
) {
  return issueAgentKey(db, input);
}
export { listAgentKeys, revokeAgentKey } from './agent-keys.js';
export function exportWorkspace(db: DatabaseHandle): ExportData {
  return db.sqlite.transaction((): ExportData => {
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
      checklistItems: db.orm.select().from(schema.checklistItems).all(),
      agents: listAgents(db),
      events: readEvents(db),
      operations: readOperations(db),
    };
  })();
}
// Reads an export of the current format or of format 1 (schema versions 1-2,
// operations without operationSeq). Format 1 gets positions in (createdAt, id)
// order, exactly what 0002_operation_seq.sql does to an existing database, so
// both paths agree; see drizzle/v2/README.md for the data migration rule.
export function upgradeExport(raw: unknown): ExportData {
  const version = z
    .object({ formatVersion: z.unknown() })
    .loose()
    .parse(raw).formatVersion;
  if (version !== 1) return exportSchema.parse(raw);
  const legacy = exportSchemaV1.parse(raw);
  const ordered = [...legacy.operations].sort(
    (a, b) =>
      compareStrings(a.createdAt, b.createdAt) || compareStrings(a.id, b.id),
  );
  const positions = new Map(ordered.map((o, i) => [o.id, i + 1]));
  return {
    ...legacy,
    formatVersion: FORMAT_VERSION,
    operations: legacy.operations.map((o) => ({
      ...o,
      operationSeq: positions.get(o.id)!,
    })),
  };
}
export function validateExport(data: ExportData) {
  const invalid = (message: string): never =>
    fail('invalid', `Повреждённый экспорт: ${message}`);
  const same = (a: unknown, b: unknown) =>
    canonicalJson(a) === canonicalJson(b);
  const sorted = <T extends { id: string }>(rows: T[]) =>
    [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const rows of [
    data.tasks,
    data.projects,
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
    .sort((a, b) => a - b);
  if (positions.some((position, index) => position !== index + 1))
    invalid('позиции операций не образуют непрерывную последовательность.');
  const expectedItems = data.tasks.flatMap((t) =>
    t.checklist.map((item, position) => ({ ...item, taskId: t.id, position })),
  );
  if (!same(sorted(expectedItems), sorted(data.checklistItems)))
    invalid('таблица шагов не совпадает с чеклистами задач.');
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
  if (
    data.seq !== data.events.length ||
    data.events.some(
      (e, i) => e.seq !== i + 1 || e.generation !== data.generation,
    )
  )
    invalid('нарушена непрерывная последовательность событий.');
  const operations = new Map(data.operations.map((o) => [o.id, o]));
  const byOperation = new Map<string, typeof data.events>();
  let replay: WorkspaceState = { projects: [], tasks: [], comments: [] };
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
    const list =
      e.entityKind === 'task'
        ? replay.tasks
        : e.entityKind === 'project'
          ? replay.projects
          : replay.comments;
    const before = list.find((r) => r.id === e.entityId);
    if (e.recordRevision !== (before?.revision ?? 0) + 1)
      invalid('нарушена версия записи.');
    for (const [key, change] of Object.entries(e.changes))
      if (
        !same(
          change.from,
          before ? (before as unknown as Record<string, unknown>)[key] : null,
        )
      )
        invalid('история изменений не соответствует предыдущему состоянию.');
    if (
      e.entityKind === 'comment' &&
      (e.taskId ?? e.changes.taskId?.to) !==
        (before && 'taskId' in before ? before.taskId : e.changes.taskId?.to)
    )
      invalid('событие комментария указывает другую задачу.');
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
      const withoutGeneration = (rows: typeof events) =>
        rows.map(({ generation: _generation, ...event }) => event);
      if (!same(withoutGeneration(events), withoutGeneration(op.result.events)))
        invalid('события ответа не совпадают с журналом.');
    } else if (events.length || op.status < 400 || op.result.retryable)
      invalid('ошибка операции содержит события или повторяемый исход.');
  }
  const normalized = (state: WorkspaceState) => ({
    tasks: sorted(state.tasks),
    projects: sorted(state.projects),
    comments: sorted(state.comments),
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
  return db.sqlite
    .transaction(() => {
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
        fail(
          'conflict',
          'Импорт разрешён только в пустую базу или с --replace.',
        );
      for (const table of [
        schema.agentKeys,
        schema.passkey,
        schema.session,
        schema.account,
        schema.verification,
        schema.user,
        schema.comments,
        schema.checklistItems,
        schema.tasks,
        schema.projects,
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
        db.orm.insert(schema.operations).values(o).run();
      db.sqlite
        .prepare("DELETE FROM sqlite_sequence WHERE name='events'")
        .run();
      db.sqlite
        .prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('events',?)")
        .run(data.seq);
      return markRestored(db, options.migrationsDir);
    })
    .immediate();
}
export function markRestored(db: DatabaseHandle, migrationsDir?: string) {
  assertSchema(db, migrationsDir);
  const next = randomUUID();
  db.sqlite
    .transaction(() => {
      setSetting(db, 'generation', next);
      db.orm
        .delete(schema.settings)
        .where(eq(schema.settings.key, 'approved_deployment'))
        .run();
    })
    .immediate();
  return { generation: next, seq: latestSeq(db) };
}
export function openWrites(db: DatabaseHandle, deploymentId: string) {
  if (!deploymentId)
    fail('invalid', 'Для открытия записи нужен идентификатор деплоя.');
  setSetting(db, 'approved_deployment', deploymentId);
  return { writes: 'open' as const, deploymentId };
}
export function writesAreOpen(
  db: DatabaseHandle,
  mode: 'held' | 'open' = 'open',
  deploymentId?: string,
) {
  return (
    mode !== 'held' ||
    Boolean(
      deploymentId && getSetting(db, 'approved_deployment') === deploymentId,
    )
  );
}
