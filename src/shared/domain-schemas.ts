import {
  z,
  idSchema,
  areaSchema,
  statusSchema,
  dateSchema,
  checklistSchema,
} from './schemas.js';
const stamp = z.iso.datetime({ offset: true }).describe('Момент времени UTC');
const nullableStamp = stamp.nullable();
const revision = z.number().int().positive().describe('Версия записи');
export const actorSchema = z
  .object({
    id: z.string().describe('Идентичность актора'),
    label: z.string().describe('Имя актора'),
    kind: z.enum(['owner', 'agent']).describe('Владелец или агент'),
    scope: z.enum(['read', 'tasks', 'write']).describe('Права'),
    agentId: idSchema.optional(),
  })
  .strict();
export const projectSchema = z
  .object({
    id: idSchema,
    area: areaSchema,
    name: z.string().min(1).max(60).describe('Название проекта'),
    description: z.string().max(500).describe('Что относится к проекту'),
    color: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .describe('Цвет проекта'),
    revision,
    createdAt: stamp,
    updatedAt: stamp,
  })
  .strict();
export const taskSchema = z
  .object({
    id: idSchema,
    area: areaSchema,
    projectId: idSchema.nullable().describe('Проект или null'),
    title: z.string().min(1).max(240).describe('Название'),
    status: statusSchema,
    note: z.string().max(16000).describe('Заметка'),
    due: dateSchema,
    waitingFor: z.string().max(240).describe('Чего ждём'),
    followUp: dateSchema,
    orderKey: z
      .string()
      .min(1)
      .describe('Серверный бинарно сортируемый ключ порядка'),
    focus: z.boolean().describe('Выбрано в Focus'),
    archived: z.boolean().describe('В архиве'),
    checklist: checklistSchema,
    commentCount: z
      .number()
      .int()
      .nonnegative()
      .describe('Количество неудалённых комментариев'),
    originSystem: z
      .string()
      .regex(/^[a-z0-9_-]{1,40}$/)
      .nullable()
      .describe('Система источника'),
    originRef: z
      .string()
      .min(1)
      .max(200)
      .nullable()
      .describe('Идентификатор в источнике'),
    originUrl: z
      .url()
      .max(2000)
      .refine((v) => /^https?:\/\//.test(v))
      .nullable()
      .describe('Ссылка на источник'),
    originVersion: z
      .string()
      .max(120)
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
  .strict();
export const commentSchema = z
  .object({
    id: idSchema,
    taskId: idSchema.describe('Задача'),
    actorId: z.string().describe('Автор'),
    actorLabel: z.string().describe('Метка автора'),
    text: z.string().min(1).max(4000).describe('Комментарий'),
    revision,
    createdAt: stamp,
    deletedAt: nullableStamp.describe('Мягкое удаление'),
  })
  .strict();
export const agentSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).max(100).describe('Имя агента'),
    createdAt: stamp,
    disabledAt: nullableStamp.describe('Когда отключён'),
  })
  .strict();
export const entitySchema = z
  .union([taskSchema, projectSchema, commentSchema])
  .describe('Задача, проект или комментарий');
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
  .describe('Изменённые предметные поля и технические метаданные');
export const eventSchema = z
  .object({
    seq: z.number().int().positive().describe('Номер события'),
    generation: idSchema.describe('Поколение базы'),
    at: stamp,
    actorId: z.string().describe('Актор'),
    actorLabel: z.string().describe('Имя актора в момент события'),
    operationId: idSchema,
    entityKind: z.enum(['task', 'project', 'comment']).describe('Вид записи'),
    entityId: idSchema,
    taskId: idSchema.optional().describe('Задача события комментария'),
    command: z.string().describe('Команда'),
    changes: changesSchema,
    recordRevision: revision,
    firstSeq: z.number().int().positive().describe('Первое событие операции'),
    lastSeq: z.number().int().positive().describe('Последнее событие операции'),
  })
  .strict();
export const snapshotSchema = z
  .object({
    generation: idSchema,
    seq: z.number().int().nonnegative().describe('Последнее событие снимка'),
    today: dateSchema
      .nonoptional()
      .refine((v) => v !== null)
      .describe('Сегодня в часовом поясе пространства'),
    timezone: z.string().describe('Часовой пояс IANA'),
    projects: z.array(projectSchema).describe('Проекты'),
    tasks: z.array(taskSchema).describe('Все задачи, включая архив'),
  })
  .strict();
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
  })
  .strict();
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
  .strict();
export const errorCodeSchema = z.enum([
  'invalid',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'operation_mismatch',
  'generation_changed',
  'not_undoable',
  'unavailable',
]);
export const operationErrorSchema = z
  .object({
    ok: z.literal(false),
    code: errorCodeSchema,
    message: z.string().describe('Сообщение на русском'),
    retryable: z.boolean().describe('Можно повторить тот же конверт'),
    current: entitySchema.optional().describe('Актуальная запись'),
    conflicts: z
      .array(
        z.object({
          entityKind: z.enum(['task', 'project', 'comment']),
          entityId: idSchema,
          fields: z.array(z.string()),
        }),
      )
      .optional(),
    commandIndex: z.number().int().nonnegative().optional(),
    operationId: idSchema.optional(),
    generation: idSchema.optional(),
  })
  .strict();
export const operationResponseSchema = z.union([
  operationSuccessSchema,
  operationErrorSchema,
]);
export const operationSummarySchema = z
  .object({
    id: idSchema,
    status: z.number().int(),
    ok: z.boolean(),
    errorCode: errorCodeSchema.optional(),
    errorMessage: z.string().optional(),
    actorId: z.string(),
    actorLabel: z.string(),
    command: z.string(),
    createdAt: stamp,
    taskCount: z.number().int().nonnegative(),
    titles: z.array(z.string()),
    firstSeq: z.number().int().positive().nullable(),
    lastSeq: z.number().int().positive().nullable(),
  })
  .strict();
export const storedOperationSchema = operationSummarySchema.extend({
  status: z.number().int(),
  result: operationResponseSchema,
});
export const eventsPageSchema = z.object({
  generation: idSchema,
  latestSeq: z.number().int().nonnegative(),
  more: z.boolean(),
  events: z.array(eventSchema),
});
export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    generation: idSchema,
    seq: z.number().int().nonnegative(),
    items: z.array(item),
    more: z.boolean(),
    nextCursor: z.string().nullable(),
  });
export const exportSchema = z
  .object({
    formatVersion: z.literal(1),
    exportedAt: stamp,
    generation: idSchema,
    seq: z.number().int().nonnegative(),
    settings: z.record(z.string(), z.string()),
    projects: z.array(projectSchema),
    tasks: z.array(taskSchema),
    checklistItems: z.array(
      z.object({
        id: idSchema,
        taskId: idSchema,
        text: z.string().min(1).max(500),
        done: z.boolean(),
        position: z.number().int().nonnegative(),
      }),
    ),
    comments: z.array(commentSchema),
    agents: z.array(agentSchema),
    events: z.array(eventSchema),
    operations: z.array(
      storedOperationSchema.extend({ commandHash: z.string() }),
    ),
  })
  .strict();
