import { z } from '@hono/zod-openapi';
export { z };
export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,80}$/)
  .describe('Устойчивый идентификатор, до 80 символов');
export const revisionSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER)
  .describe('Базовая версия прочитанной записи');
export const areaSchema = z
  .enum(['agency', 'development', 'personal'])
  .describe('Область задачи или проекта');
export const statusSchema = z
  .enum(['todo', 'doing', 'waiting', 'done'])
  .describe('Состояние задачи');
const text = (max: number, required = false) =>
  z
    .string()
    .trim()
    .min(required ? 1 : 0)
    .max(max);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T12:00:00Z`);
    return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === v;
  }, 'Укажите существующую дату')
  .nullable()
  .describe('Календарная дата YYYY-MM-DD или null');
export const checklistItemSchema = z
  .object({
    id: idSchema,
    text: text(500, true).describe('Текст шага'),
    done: z.boolean().describe('Шаг выполнен'),
  })
  .strict();
export const checklistSchema = z
  .array(checklistItemSchema)
  .max(100)
  .refine(
    (v) => new Set(v.map((x) => x.id)).size === v.length,
    'Шаги должны иметь разные идентификаторы',
  )
  .describe('До 100 шагов задачи');
export const originSchema = z
  .object({
    system: z
      .string()
      .regex(/^[a-z0-9_-]{1,40}$/)
      .describe('Слаг источника'),
    ref: text(200, true).describe('Устойчивый идентификатор объекта источника'),
    url: z
      .url()
      .max(2000)
      .refine((v) => /^https?:\/\//.test(v), 'Только http и https')
      .optional()
      .describe('Ссылка на источник'),
    version: text(120, true)
      .optional()
      .describe('Упорядоченная версия самого источника, не время наблюдения'),
  })
  .strict();
export const positionSchema = z
  .union([
    z.object({ before: idSchema }).strict(),
    z.object({ after: idSchema }).strict(),
  ])
  .describe('Положение относительно соседней задачи');
export const taskFieldsSchema = z
  .object({
    area: areaSchema.optional(),
    projectId: idSchema.nullable().optional().describe('Проект или null'),
    title: text(240, true).optional().describe('Название'),
    note: text(16000).optional().describe('Заметка'),
    due: dateSchema.optional(),
    waitingFor: text(240).optional().describe('Чего ждём'),
    followUp: dateSchema.optional(),
    focus: z.boolean().optional().describe('Выбрано владельцем в Focus'),
  })
  .strict();
const createFields = taskFieldsSchema.extend({
  area: areaSchema,
  title: text(240, true).describe('Название задачи'),
  status: statusSchema.optional(),
  checklist: checklistSchema.optional(),
});
const schemas = {
  'project.create': z
    .object({
      id: idSchema.optional(),
      area: areaSchema,
      name: text(60, true).describe('Название проекта'),
      color: z
        .string()
        .regex(/^#[a-fA-F0-9]{6}$/)
        .describe('Цвет #rrggbb'),
      description: text(500).optional().describe('Что складывать в проект'),
    })
    .strict(),
  'project.update': z
    .object({
      id: idSchema,
      baseRevision: revisionSchema,
      name: text(60, true).optional().describe('Название проекта'),
      color: z
        .string()
        .regex(/^#[a-fA-F0-9]{6}$/)
        .optional()
        .describe('Цвет проекта'),
      description: text(500).optional().describe('Описание проекта'),
    })
    .strict(),
  'task.create': createFields
    .extend({
      id: idSchema.optional(),
      origin: originSchema.optional(),
      position: positionSchema.optional(),
    })
    .strict(),
  'task.sync': z
    .object({ origin: originSchema, fields: createFields })
    .strict(),
  'task.update': taskFieldsSchema
    .extend({ id: idSchema, baseRevision: revisionSchema })
    .strict(),
  'task.save': z
    .object({
      id: idSchema,
      baseRevision: revisionSchema,
      fields: taskFieldsSchema.optional(),
      status: statusSchema.optional(),
      position: positionSchema.optional(),
      checklist: checklistSchema.optional(),
    })
    .strict(),
  'task.move': z
    .object({
      id: idSchema,
      baseRevision: revisionSchema,
      status: statusSchema,
      before: idSchema.optional(),
      after: idSchema.optional(),
    })
    .strict()
    .refine((v) => !(v.before && v.after), 'Выберите одного соседа'),
  'task.archive': z
    .object({ id: idSchema, baseRevision: revisionSchema })
    .strict(),
  'task.restore': z
    .object({ id: idSchema, baseRevision: revisionSchema })
    .strict(),
  'checklist.add': z
    .object({
      taskId: idSchema,
      baseRevision: revisionSchema,
      id: idSchema.optional(),
      text: text(500, true).describe('Текст шага'),
      position: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('Позиция шага, с нуля'),
    })
    .strict(),
  'checklist.update': z
    .object({
      taskId: idSchema,
      baseRevision: revisionSchema,
      itemId: idSchema,
      text: text(500, true).optional().describe('Текст шага'),
      done: z.boolean().optional().describe('Шаг выполнен'),
    })
    .strict(),
  'checklist.remove': z
    .object({
      taskId: idSchema,
      baseRevision: revisionSchema,
      itemId: idSchema,
    })
    .strict(),
  'checklist.reorder': z
    .object({
      taskId: idSchema,
      baseRevision: revisionSchema,
      itemIds: z.array(idSchema).max(100).describe('Все шаги в нужном порядке'),
    })
    .strict(),
  'comment.add': z
    .object({
      taskId: idSchema,
      id: idSchema.optional(),
      text: text(4000, true).describe('Комментарий или отчёт агента'),
    })
    .strict(),
  'comment.remove': z.object({ commentId: idSchema }).strict(),
  undo: z.union([
    z
      .object({
        seq: z.number().int().positive().describe('Событие для отмены'),
      })
      .strict(),
    z
      .object({ operationId: idSchema.describe('Операция для отмены') })
      .strict(),
  ]),
};
export const commandPayloadSchemas = schemas;
const envelopeFields = {
  operationId: idSchema,
  generation: idSchema,
  dryRun: z.boolean().optional().describe('Проверить без записи'),
};
export const commandSchema = z.discriminatedUnion('command', [
  z
    .object({
      command: z.literal('project.create').describe('Имя команды'),
      payload: schemas['project.create'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      command: z.literal('project.update').describe('Имя команды'),
      payload: schemas['project.update'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      command: z.literal('task.create').describe('Имя команды'),
      payload: schemas['task.create'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      command: z.literal('task.sync').describe('Имя команды'),
      payload: schemas['task.sync'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      command: z.literal('task.update').describe('Имя команды'),
      payload: schemas['task.update'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      command: z.literal('task.save').describe('Имя команды'),
      payload: schemas['task.save'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      command: z.literal('task.move').describe('Имя команды'),
      payload: schemas['task.move'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      command: z.literal('task.archive').describe('Имя команды'),
      payload: schemas['task.archive'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      command: z.literal('task.restore').describe('Имя команды'),
      payload: schemas['task.restore'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      command: z.literal('checklist.add').describe('Имя команды'),
      payload: schemas['checklist.add'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      command: z.literal('checklist.update').describe('Имя команды'),
      payload: schemas['checklist.update'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      command: z.literal('checklist.remove').describe('Имя команды'),
      payload: schemas['checklist.remove'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      command: z.literal('checklist.reorder').describe('Имя команды'),
      payload: schemas['checklist.reorder'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      command: z.literal('comment.add').describe('Имя команды'),
      payload: schemas['comment.add'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      command: z.literal('comment.remove').describe('Имя команды'),
      payload: schemas['comment.remove'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      command: z.literal('undo').describe('Имя команды'),
      payload: schemas['undo'].describe('Параметры команды'),
    })
    .strict(),
]);
export const commandEnvelopeSchema = z.discriminatedUnion('command', [
  z
    .object({
      ...envelopeFields,
      command: z.literal('project.create').describe('Имя команды'),
      payload: schemas['project.create'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      command: z.literal('project.update').describe('Имя команды'),
      payload: schemas['project.update'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      command: z.literal('task.create').describe('Имя команды'),
      payload: schemas['task.create'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      command: z.literal('task.sync').describe('Имя команды'),
      payload: schemas['task.sync'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      command: z.literal('task.update').describe('Имя команды'),
      payload: schemas['task.update'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      command: z.literal('task.save').describe('Имя команды'),
      payload: schemas['task.save'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      command: z.literal('task.move').describe('Имя команды'),
      payload: schemas['task.move'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      command: z.literal('task.archive').describe('Имя команды'),
      payload: schemas['task.archive'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      command: z.literal('task.restore').describe('Имя команды'),
      payload: schemas['task.restore'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      command: z.literal('checklist.add').describe('Имя команды'),
      payload: schemas['checklist.add'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      command: z.literal('checklist.update').describe('Имя команды'),
      payload: schemas['checklist.update'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      command: z.literal('checklist.remove').describe('Имя команды'),
      payload: schemas['checklist.remove'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      command: z.literal('checklist.reorder').describe('Имя команды'),
      payload: schemas['checklist.reorder'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      command: z.literal('comment.add').describe('Имя команды'),
      payload: schemas['comment.add'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      command: z.literal('comment.remove').describe('Имя команды'),
      payload: schemas['comment.remove'].describe('Параметры команды'),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      command: z.literal('undo').describe('Имя команды'),
      payload: schemas['undo'].describe('Параметры команды'),
    })
    .strict(),
]);
export const batchEnvelopeSchema = z
  .object({
    ...envelopeFields,
    commands: z
      .array(commandSchema)
      .min(1)
      .max(100)
      .describe('Атомарный пакет до 100 команд'),
  })
  .strict();
export type Command = z.infer<typeof commandSchema>;
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export type BatchEnvelope = z.infer<typeof batchEnvelopeSchema>;
export function parseCommand(command: Command): Command {
  return commandSchema.parse(command);
}
