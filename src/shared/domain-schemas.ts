import { z } from 'zod';
import {
  idSchema,
  areaSchema,
  statusSchema,
  dateSchema,
  checklistSchema,
  originSystemSchema,
  commandNameSchema,
  commandNames,
  prioritySchema,
  labelSchema,
  storedLabelsSchema,
  closesSchema,
} from './schemas.js';
import { LIMITS } from './limits.js';
import { DEFAULT_PRIORITY } from './labels.js';
import { ENTITY_KINDS } from './entities.js';
import {
  appearanceModeSchema,
  DEFAULT_APPEARANCE_ID,
  DEFAULT_APPEARANCE_MODE,
  DEFAULT_SKIN_ID,
} from './appearance.js';
// Every entity and response schema carries `.meta({ id })`: the OpenAPI
// document then lists it once under components.schemas and refers to it from
// each route. `.extend()` drops the id, so derived schemas set their own.
const stamp = z.iso.datetime({ offset: true }).describe('Момент времени UTC');
const nullableStamp = stamp.nullable();
const revision = z.number().int().positive().describe('Версия записи');
const seq = z.number().int().nonnegative();
// Not strict: /api/me answers with the actor plus generation and seq
// (meSchema), so a client that parses the actor alone keeps working.
export const actorSchema = z
  .object({
    id: z.string().describe('Идентичность актора'),
    label: z.string().describe('Имя актора'),
    kind: z.enum(['owner', 'agent']).describe('Владелец или агент'),
    scope: z.enum(['read', 'tasks', 'write']).describe('Права'),
    agentId: idSchema.optional(),
  })
  .meta({ id: 'Actor' });
export const meSchema = actorSchema
  .extend({
    generation: idSchema.describe('Текущее поколение базы'),
    seq: seq.describe('Последнее событие'),
  })
  .meta({ id: 'Me' });
export const projectSchema = z
  .object({
    id: idSchema,
    area: areaSchema,
    name: z
      .string()
      .min(1)
      .max(LIMITS.projectName)
      .describe('Название проекта'),
    description: z
      .string()
      .max(LIMITS.projectDescription)
      .describe('Что относится к проекту'),
    color: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .describe('Цвет проекта'),
    revision,
    createdAt: stamp,
    updatedAt: stamp,
  })
  .strict()
  .meta({ id: 'Project' });
export const taskSchema = z
  .object({
    id: idSchema,
    area: areaSchema,
    projectId: idSchema.nullable().describe('Проект или null'),
    title: z.string().min(1).max(LIMITS.taskTitle).describe('Название'),
    status: statusSchema,
    priority: prioritySchema.default(DEFAULT_PRIORITY),
    labels: storedLabelsSchema.default([]),
    closes: closesSchema.default(null),
    note: z.string().max(LIMITS.taskNote).describe('Заметка'),
    due: dateSchema,
    waitingFor: z.string().max(LIMITS.waitingFor).describe('Чего ждём'),
    followUp: dateSchema,
    orderKey: z
      .string()
      .min(1)
      .describe('Серверный бинарно сортируемый ключ порядка'),
    focus: z.boolean().describe('Выбрано в Focus'),
    // Absent in records stored before 0004_focus_desk (operation results):
    // read as null, the value the migration gives tasks outside the desk.
    focusKey: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .describe(
        'Ключ порядка на столе Focus (наименьший — текущая задача); null вне фокуса',
      ),
    focusLeftAt: nullableStamp
      .default(null)
      .describe('Момент последнего выхода из фокуса'),
    archived: z.boolean().describe('В архиве'),
    checklist: checklistSchema,
    commentCount: z
      .number()
      .int()
      .nonnegative()
      .describe('Количество неудалённых комментариев'),
    originSystem: originSystemSchema.nullable().describe('Система источника'),
    originRef: z
      .string()
      .min(1)
      .max(LIMITS.originRef)
      .nullable()
      .describe('Идентификатор в источнике'),
    originUrl: z
      .url()
      .max(LIMITS.originUrl)
      .refine((v) => /^https?:\/\//.test(v))
      .nullable()
      .describe('Ссылка на источник'),
    originVersion: z
      .string()
      .max(LIMITS.originVersion)
      .nullable()
      .describe('Наибольшая обработанная версия источника'),
    createdBy: z.string().describe('Актор создания'),
    createdByLabel: z.string().describe('Метка автора создания'),
    ownerTouchedAt: nullableStamp.describe('Первое ручное изменение'),
    ownerFields: z
      .array(z.string())
      .describe('Защищённые ручными правками поля'),
    revision,
    createdAt: stamp,
    updatedAt: stamp,
  })
  .strict()
  .meta({ id: 'Task' });
export const commentSchema = z
  .object({
    id: idSchema,
    taskId: idSchema.describe('Задача'),
    actorId: z.string().describe('Автор'),
    actorLabel: z.string().describe('Метка автора'),
    text: z.string().min(1).max(LIMITS.commentText).describe('Комментарий'),
    revision,
    createdAt: stamp,
    deletedAt: nullableStamp.describe('Мягкое удаление'),
  })
  .strict()
  .meta({ id: 'Comment' });
export const agentSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).max(LIMITS.agentLabel).describe('Имя агента'),
    createdAt: stamp,
    disabledAt: nullableStamp.describe('Когда отключён'),
  })
  .strict()
  .meta({ id: 'Agent' });
// The owner's appearance preference: one record with a stable id. `skinId` is
// a plain string on the way out so a client of an older build can fall back to
// Classic instead of failing to parse the response; writes accept only an id
// of the current catalogue (skinIdSchema in schemas.ts).
export const appearanceSchema = z
  .object({
    id: idSchema.describe('Всегда owner: предпочтение одно на пространство'),
    mode: appearanceModeSchema,
    skinId: z.string().min(1).max(LIMITS.id).describe('Выбранный скин'),
    hideP3: z
      .boolean()
      .default(false)
      .describe('Скрывать P3 на доске и в списке'),
    revision,
    updatedAt: nullableStamp.describe('Когда владелец менял оформление'),
  })
  .strict()
  .meta({ id: 'Appearance' });

// The preference exists from the first read: an untouched workspace has no row
// and answers this record, so revision 1 is a valid baseRevision right away.
export const defaultAppearance = (): z.infer<typeof appearanceSchema> => ({
  id: DEFAULT_APPEARANCE_ID,
  mode: DEFAULT_APPEARANCE_MODE,
  skinId: DEFAULT_SKIN_ID,
  hideP3: false,
  revision: 1,
  updatedAt: null,
});

export const entityKindSchema = z.enum(ENTITY_KINDS).describe('Вид записи');

export const entitySchema = z
  .union([taskSchema, projectSchema, commentSchema, appearanceSchema])
  .describe('Задача, проект, комментарий или оформление')
  .meta({ id: 'Entity' });
export const changesSchema = z
  .record(
    z.string(),
    z
      .object({
        from: z.unknown().describe('Предыдущее значение JSON'),
        to: z.unknown().describe('Новое значение JSON'),
      })
      .strict(),
  )
  .describe('Изменённые предметные поля и технические метаданные')
  .meta({ id: 'Changes' });
export const eventSchema = z
  .object({
    seq: z.number().int().positive().describe('Номер события'),
    generation: idSchema.describe('Поколение базы'),
    at: stamp,
    actorId: z.string().describe('Актор'),
    actorLabel: z.string().describe('Имя актора в момент события'),
    operationId: idSchema,
    entityKind: entityKindSchema,
    entityId: idSchema,
    taskId: idSchema.optional().describe('Задача события комментария'),
    command: commandNameSchema.describe('Команда'),
    changes: changesSchema,
    recordRevision: revision,
    firstSeq: z.number().int().positive().describe('Первое событие операции'),
    lastSeq: z.number().int().positive().describe('Последнее событие операции'),
  })
  .strict()
  .meta({ id: 'Event' });
export const snapshotSchema = z
  .object({
    generation: idSchema,
    seq: seq.describe('Последнее событие снимка'),
    schemaVersion: z
      .number()
      .int()
      .describe(
        'Версия схемы сервера; другое значение у следующего снимка означает обновление сервера',
      ),
    today: dateSchema
      .nonoptional()
      .refine((v) => v !== null)
      .describe('Сегодня в часовом поясе пространства'),
    timezone: z.string().describe('Часовой пояс IANA'),
    projects: z.array(projectSchema).describe('Проекты'),
    tasks: z.array(taskSchema).describe('Все задачи, включая архив'),
    // Обязательно с 2026-09-11: сервер всегда шлёт запись (её отдаёт
    // defaultAppearance() даже для нетронутого пространства), а необязательное
    // поле заставляло каждого потребителя снимка держать ветку «а вдруг нет».
    appearance: appearanceSchema.describe('Предпочтение оформления владельца'),
  })
  .strict()
  .meta({ id: 'Snapshot' });
export const commandResultSchema = z
  .object({
    record: entitySchema.nullable().describe('Результат команды'),
    records: z
      .array(entitySchema)
      .optional()
      .describe('Записи многообъектной отмены'),
    changes: changesSchema,
    existing: z
      .boolean()
      .optional()
      .describe('Задача источника уже существует'),
    applied: z.array(z.string()).optional().describe('Применённые поля'),
    skipped: z
      .union([
        z.literal('all'),
        z.array(
          z.object({
            field: z.string().describe('Поле'),
            reason: z.string().describe('Причина'),
          }),
        ),
      ])
      .optional()
      .describe('Пропущенные поля'),
    reason: z.string().optional().describe('Причина полного пропуска'),
    confirmedOwnerFields: z
      .array(z.string())
      .optional()
      .describe(
        'Поля из ownerFields, изменённые агентом с confirmOwnerFields: true (след поручения)',
      ),
  })
  .strict()
  .meta({ id: 'CommandResult' });
export const operationSuccessSchema = z
  .object({
    ok: z.literal(true),
    operationId: idSchema,
    generation: idSchema,
    firstSeq: z.number().int().positive().nullable(),
    lastSeq: z.number().int().positive().nullable(),
    results: z
      .array(commandResultSchema)
      .describe('Результаты по позициям команд'),
    events: z.array(eventSchema).describe('Все события атомарной операции'),
    dryRun: z.boolean().optional(),
  })
  .strict()
  .meta({ id: 'OperationSuccess' });
export const errorCodeSchema = z
  .enum([
    'invalid',
    'unauthorized',
    'forbidden',
    'not_found',
    'conflict',
    'operation_mismatch',
    'generation_changed',
    'not_undoable',
    'unavailable',
    'internal',
  ])
  .meta({ id: 'ErrorCode' });
export const operationIssueSchema = z
  .object({
    path: z
      .string()
      .describe(
        'Путь к полю: payload.title, commands[1].payload.area, query.limit',
      ),
    message: z.string().describe('Сообщение на русском'),
  })
  .strict()
  .meta({ id: 'OperationIssue' });
export const operationErrorSchema = z
  .object({
    ok: z.literal(false),
    code: errorCodeSchema,
    message: z.string().describe('Сообщение на русском'),
    retryable: z.boolean().describe('Можно повторить тот же конверт'),
    issues: z
      .array(operationIssueSchema)
      .optional()
      .describe('Ошибки валидации по полям'),
    current: entitySchema.optional().describe('Актуальная запись'),
    conflicts: z
      .array(
        z.object({
          entityKind: entityKindSchema,
          entityId: idSchema,
          fields: z.array(z.string()),
        }),
      )
      .optional(),
    commandIndex: z.number().int().nonnegative().optional(),
    operationId: idSchema.optional(),
    generation: idSchema.optional(),
  })
  .strict()
  .meta({ id: 'OperationError' });
export const operationResponseSchema = z
  .union([operationSuccessSchema, operationErrorSchema])
  .meta({ id: 'OperationResponse' });
export const operationSeqSchema = z
  .number()
  .int()
  .positive()
  .describe(
    'Позиция в журнале операций; растёт у каждой сохранённой операции, в том числе без событий',
  );
export const operationSummarySchema = z
  .object({
    id: idSchema,
    operationSeq: operationSeqSchema,
    status: z.number().int(),
    ok: z.boolean(),
    errorCode: errorCodeSchema.optional(),
    errorMessage: z.string().optional(),
    actorId: z.string(),
    actorLabel: z.string(),
    command: z.enum([...commandNames, 'batch']).describe('Команда или batch'),
    createdAt: stamp,
    taskCount: z.number().int().nonnegative(),
    titles: z.array(z.string()),
    firstSeq: z.number().int().positive().nullable(),
    lastSeq: z.number().int().positive().nullable(),
  })
  .strict()
  .meta({ id: 'OperationSummary' });
export const storedOperationSchema = operationSummarySchema
  .extend({
    status: z.number().int(),
    result: operationResponseSchema,
  })
  .meta({ id: 'StoredOperation' });
export const eventsPageSchema = z
  .object({
    generation: idSchema,
    latestSeq: seq,
    more: z.boolean(),
    events: z.array(eventSchema),
  })
  .meta({ id: 'EventsPage' });
export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    generation: idSchema,
    seq,
    items: z.array(item),
    more: z.boolean(),
    nextCursor: z.string().nullable(),
  });
const exportedOperationSchema = storedOperationSchema.extend({
  operationSeq: operationSeqSchema,
  commandHash: z.string(),
});
const exportFields = {
  exportedAt: stamp,
  generation: idSchema,
  seq,
  settings: z.record(z.string(), z.string()),
  projects: z.array(projectSchema),
  tasks: z.array(taskSchema),
  checklistItems: z.array(
    z.object({
      id: idSchema,
      taskId: idSchema,
      text: z.string().min(1).max(LIMITS.checklistText),
      done: z.boolean(),
      position: z.number().int().nonnegative(),
    }),
  ),
  comments: z.array(commentSchema),
  agents: z.array(agentSchema),
  events: z.array(eventSchema),
};
// Tasks as formats 1-3 wrote them: without the desk fields of plan 13.
const legacyTaskSchema = taskSchema.omit({ focusKey: true, focusLeftAt: true });
const legacyExportFields = {
  ...exportFields,
  tasks: z.array(legacyTaskSchema),
};
export const exportSchema = z
  .object({
    formatVersion: z.literal(6),
    ...exportFields,
    operations: z.array(exportedOperationSchema),
    appearance: z
      .array(appearanceSchema)
      .describe('Предпочтение оформления владельца (одна запись)'),
  })
  .strict()
  .meta({ id: 'Export' });
// Format 1 (schema versions 1-2): operations without operationSeq. Import
// assigns positions in (createdAt, id) order, the same rule the migration
// 0002_operation_seq.sql applies to an existing database.
export const exportSchemaV1 = z
  .object({
    formatVersion: z.literal(1),
    ...legacyExportFields,
    operations: z.array(exportedOperationSchema.omit({ operationSeq: true })),
  })
  .strict();
// Format 2 (schema versions 3): no appearance record. Import adds the default
// preference, exactly what a database without an `appearance` row answers.
export const exportSchemaV2 = z
  .object({
    formatVersion: z.literal(2),
    ...legacyExportFields,
    operations: z.array(exportedOperationSchema),
  })
  .strict();
// Format 3 (schema version 4): tasks without focusKey and focusLeftAt. Import
// assigns keys to focused tasks in board order, exactly what
// 0004_focus_desk.sql does to an existing database.
export const exportSchemaV3 = z
  .object({
    formatVersion: z.literal(3),
    ...legacyExportFields,
    operations: z.array(exportedOperationSchema),
    appearance: z.array(appearanceSchema),
  })
  .strict();
// Format 4 (schema version 5): defaults restore the new fields without
// rewriting historical events or saved operation results.
export const exportSchemaV4 = z
  .object({
    formatVersion: z.literal(4),
    ...exportFields,
    operations: z.array(exportedOperationSchema),
    appearance: z.array(appearanceSchema),
  })
  .strict();
// Format 5 (schema version 6): task rows may carry the retired label otvet.
// Import drops it from tasks, exactly what 0006_drop_otvet_label.sql does to
// an existing database; events and stored results stay as written.
export const exportSchemaV5 = z
  .object({
    formatVersion: z.literal(5),
    ...exportFields,
    operations: z.array(exportedOperationSchema),
    appearance: z.array(appearanceSchema),
  })
  .strict();
export const focusGroupSchema = z
  .object({
    id: z.enum(['selected', 'new', 'due', 'follow-ups']),
    title: z.string(),
    tasks: z.array(taskSchema),
  })
  .meta({ id: 'FocusGroup' });
// The desk (plan 13, §3.3): what the owner does now, what comes next, whom
// they wait for and what is easy to return to.
const count = z.number().int().nonnegative();
export const focusDeskSchema = z
  .object({
    // A union with null, not `.nullable()`: the OpenAPI generator inlines a
    // nullable component, a union keeps the $ref to Task.
    current: z
      .union([taskSchema, z.null()])
      .describe('Текущая задача: в фокусе с наименьшим focusKey'),
    next: z
      .array(taskSchema)
      .max(LIMITS.deskNext)
      .describe(`Следующие ${LIMITS.deskNext} по focusKey`),
    waiting: z
      .array(taskSchema)
      .describe(
        'Задачи со статусом waiting: сначала с наступившей followUp, затем по followUp, без даты — последними',
      ),
    recent: z
      .array(taskSchema)
      .max(LIMITS.deskRecent)
      .describe(
        `Снятые с фокуса за ${LIMITS.deskRecentDays} дней, новые сверху, не больше ${LIMITS.deskRecent}`,
      ),
    counts: z.object({
      focus: count.describe('Всего в фокусе (счётчик Focus)'),
      parked: count.describe('В очереди и не в фокусе'),
      waiting: count.describe('Со статусом waiting'),
    }),
  })
  .meta({ id: 'FocusDesk' });
export const focusResponseSchema = z
  .union([
    pageSchema(taskSchema).meta({ id: 'TaskPage' }),
    focusDeskSchema.extend({
      generation: idSchema,
      seq,
      groups: z.array(focusGroupSchema),
    }),
  ])
  .meta({ id: 'FocusResponse' });
export const projectsResponseSchema = z
  .object({ projects: z.array(projectSchema) })
  .meta({ id: 'ProjectsResponse' });
export const healthSchema = z
  .object({
    ok: z.boolean(),
    generation: idSchema,
    seq,
    dbWritable: z.boolean(),
    schemaVersion: z.number().int(),
    build: z.string(),
    writes: z.enum(['held', 'open']),
  })
  .meta({ id: 'Health' });
const jsonSchema = z.record(z.string(), z.unknown());
export const contextSchema = z
  .object({
    formatVersion: z.number().describe('Версия формата экспорта'),
    generation: idSchema,
    seq,
    today: z.string(),
    timezone: z.string(),
    me: actorSchema,
    agents: z.array(agentSchema).describe('Известные агенты'),
    areas: z.array(
      z.object({
        id: areaSchema,
        name: z.string(),
        color: z.string(),
        description: z.string(),
      }),
    ),
    statuses: z.array(
      z.object({
        id: statusSchema,
        name: z.string(),
        hint: z.string(),
        color: z.string(),
      }),
    ),
    projects: z.array(projectSchema),
    originSystems: z.array(z.string()),
    priorities: z.array(
      z.object({ id: prioritySchema, name: z.string(), hint: z.string() }),
    ),
    labels: z.array(
      z.object({
        id: labelSchema,
        name: z.string(),
        color: z.string(),
        description: z.string(),
      }),
    ),
    fields: jsonSchema.describe('JSON Schema полей задачи'),
    commands: z.array(
      z.object({
        command: commandNameSchema,
        payload: jsonSchema.describe('JSON Schema параметров команды'),
      }),
    ),
    rules: z.array(z.string()),
    counts: z.object({
      tasks: z.number(),
      archived: z.number(),
      projects: z.number(),
      areas: z.record(z.string(), z.number()),
      statuses: z.record(z.string(), z.number()),
      focus: z.array(z.object({ id: z.string(), count: z.number() })),
    }),
    links: z.object({
      openapi: z.string(),
      snapshot: z.string(),
      events: z.string(),
      export: z.string(),
    }),
  })
  .meta({ id: 'Context' });
export const digestCommentSchema = commentSchema
  .extend({
    taskTitle: z.string().describe('Название задачи'),
    seq: z.number().int().positive().describe('Событие создания комментария'),
  })
  .meta({ id: 'DigestComment' });
const href = z.string().describe('Полный список этого раздела');
export const digestSchema = z
  .object({
    generation: idSchema,
    seq: seq.describe('Последнее событие'),
    operationSeq: seq.describe('Позиция последней сохранённой операции'),
    today: z.string(),
    timezone: z.string(),
    focus: z.array(
      focusGroupSchema.extend({
        more: z.boolean(),
        nextCursor: z.string().nullable(),
        href,
      }),
    ),
    current: z
      .union([taskSchema, z.null()])
      .describe('Текущая задача стола Focus'),
    next: z
      .array(taskSchema)
      .max(LIMITS.deskNext)
      .describe('Следующие на столе'),
    waiting: pageSchema(taskSchema).extend({ href }),
    counts: z.object({
      tasks: z.number(),
      archived: z.number(),
      projects: z.number(),
      p1: z.number().describe('Незавершённые P1 вне архива'),
    }),
    operations: pageSchema(operationSummarySchema).extend({ href }),
    comments: pageSchema(digestCommentSchema)
      .extend({ href })
      .describe(
        'Комментарии владельца после since (по событиям) по возрастанию seq, не больше страницы; продолжение — digest с since = seq последнего показанного',
      ),
  })
  .meta({ id: 'Digest' });
