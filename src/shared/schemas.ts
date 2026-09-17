import { z } from 'zod';
import { LIMITS } from './limits.js';
import { appearanceModeSchema, skinIdSchema } from './appearance.js';
import { ALL_PROJECTS, NO_PROJECT } from './constants.js';
import { PRIORITY_IDS } from './labels.js';
import { SLUG_PATTERN } from './slug.js';
/** @deprecated import `z` from 'zod' directly; the re-export is kept until plan 10 removes the last consumers. */
export { z };
export const idSchema = z
  .string()
  .regex(new RegExp(`^[A-Za-z0-9_-]{1,${LIMITS.id}}$`))
  .describe(`Устойчивый идентификатор, до ${LIMITS.id} символов`);
// Words that are routes or filter values and therefore can never address a
// record: `all`/`none` are project filters, `lookup`/`by-origin` are path
// segments under /api/tasks. Checked for every new task and project id.
export const RESERVED_IDS: ReadonlySet<string> = new Set([
  ALL_PROJECTS,
  NO_PROJECT,
  'by-origin',
  'lookup',
]);
// A boolean in a query string: true/false or 1/0 (plan 10, step 9).
export const booleanQuery = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');
const newIdSchema = idSchema
  .refine(
    (id) => !RESERVED_IDS.has(id),
    'Служебное слово нельзя использовать как идентификатор',
  )
  .describe(
    'Идентификатор новой записи; служебные слова all, none, lookup, by-origin запрещены',
  );
const revisionSchema = z
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
export const prioritySchema = z
  .enum(PRIORITY_IDS)
  .describe('Приоритет: p1 горит, p2 обычная (по умолчанию), p3 когда-нибудь');
// A label is addressed by its slug; the catalogue itself lives in the
// workspace (labels of /api/context and /api/snapshot), so the domain, not the
// schema, refuses an unknown or archived one.
export const labelIdSchema = z
  .string()
  .regex(SLUG_PATTERN)
  .describe(
    'Слаг метки из каталога labels ответа /api/context (латиница, цифры, дефис)',
  );
export const labelsSchema = z
  .array(labelIdSchema)
  .max(LIMITS.taskLabels)
  .refine((v) => new Set(v).size === v.length, 'Метки не должны повторяться')
  .describe(`До ${LIMITS.taskLabels} меток из каталога, без повторов`);
export const closesSchema = z
  .string()
  .regex(new RegExp(`^[a-z0-9-]{1,${LIMITS.closes}}$`))
  .nullable()
  .describe(
    'Слаг проблемы из /OS/PROBLEMS.md, которую закрывает задача, или null',
  );
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
export const originSystemSchema = z
  .string()
  .regex(new RegExp(`^[a-z0-9_-]{1,${LIMITS.originSystem}}$`))
  .describe('Слаг источника');
const checklistItemSchema = z
  .object({
    id: idSchema,
    text: text(LIMITS.checklistText, true).describe('Текст шага'),
    done: z.boolean().describe('Шаг выполнен'),
  })
  .strict();
export const checklistSchema = z
  .array(checklistItemSchema)
  .max(LIMITS.checklistItems)
  .refine(
    (v) => new Set(v.map((x) => x.id)).size === v.length,
    'Шаги должны иметь разные идентификаторы',
  )
  .describe(`До ${LIMITS.checklistItems} шагов задачи`);
const originSchema = z
  .object({
    system: originSystemSchema,
    ref: text(LIMITS.originRef, true).describe(
      'Устойчивый идентификатор объекта источника',
    ),
    url: z
      .url()
      .max(LIMITS.originUrl)
      .refine((v) => /^https?:\/\//.test(v), 'Только http и https')
      .optional()
      .describe('Ссылка на источник'),
    version: text(LIMITS.originVersion, true)
      .optional()
      .describe('Упорядоченная версия самого источника, не время наблюдения'),
  })
  .strict();
const positionSchema = z
  .union([
    z.object({ before: idSchema }).strict(),
    z.object({ after: idSchema }).strict(),
  ])
  .describe('Положение относительно соседней задачи');
// A place on the Focus desk (plan 13): first, or next to a task in focus.
const focusPositionSchema = z
  .union([
    z.object({ first: z.literal(true) }).strict(),
    z.object({ after: idSchema }).strict(),
    z.object({ before: idSchema }).strict(),
  ])
  .describe('Место на столе Focus: первым, после или перед задачей в фокусе');
export type FocusPosition = z.infer<typeof focusPositionSchema>;
const taskFieldsSchema = z
  .object({
    area: areaSchema.optional(),
    projectId: idSchema.nullable().optional().describe('Проект или null'),
    title: text(LIMITS.taskTitle, true).optional().describe('Название'),
    note: text(LIMITS.taskNote).optional().describe('Заметка'),
    due: dateSchema.optional(),
    waitingFor: text(LIMITS.waitingFor).optional().describe('Чего ждём'),
    followUp: dateSchema.optional(),
    priority: prioritySchema.optional(),
    labels: labelsSchema.optional(),
    closes: closesSchema.optional(),
    focus: z
      .boolean()
      .optional()
      .describe(
        'Выбрано владельцем в Focus; без focusPosition — в конец стола; агентам недоступно, в sync пропускается',
      ),
    focusPosition: focusPositionSchema
      .optional()
      .describe(
        'Место на столе Focus; подразумевает focus: true; только владелец',
      ),
  })
  .strict();
// A position is a direct-write field: a new task takes the end of the desk.
const createFields = taskFieldsSchema.omit({ focusPosition: true }).extend({
  area: areaSchema,
  title: text(LIMITS.taskTitle, true).describe('Название задачи'),
  status: statusSchema.optional(),
  checklist: checklistSchema.optional(),
});
const projectColor = z
  .string()
  .regex(/^#[a-fA-F0-9]{6}$/)
  .describe('Цвет #rrggbb');
const schemas = {
  // Labels are the owner's catalogue (0007): only the owner creates, renames,
  // archives and restores them. Archiving removes the label from every task in
  // the same operation.
  'label.create': z
    .object({
      id: labelIdSchema
        .optional()
        .describe('Слаг новой метки; по умолчанию выводится из названия'),
      name: text(LIMITS.labelName, true).describe('Название метки'),
      color: projectColor,
      description: text(LIMITS.labelDescription, true).describe(
        'Когда ставить метку: по этому описанию её выбирают агенты',
      ),
    })
    .strict(),
  'label.update': z
    .object({
      id: labelIdSchema,
      baseRevision: revisionSchema,
      name: text(LIMITS.labelName, true).optional().describe('Название метки'),
      color: projectColor.optional().describe('Цвет метки'),
      description: text(LIMITS.labelDescription, true)
        .optional()
        .describe('Когда ставить метку'),
    })
    .strict(),
  'label.archive': z
    .object({ id: labelIdSchema, baseRevision: revisionSchema })
    .strict(),
  'label.restore': z
    .object({ id: labelIdSchema, baseRevision: revisionSchema })
    .strict(),
  'project.create': z
    .object({
      id: newIdSchema.optional(),
      area: areaSchema,
      name: text(LIMITS.projectName, true).describe('Название проекта'),
      color: projectColor,
      description: text(LIMITS.projectDescription)
        .optional()
        .describe('Что складывать в проект'),
    })
    .strict(),
  'project.update': z
    .object({
      id: idSchema,
      baseRevision: revisionSchema,
      name: text(LIMITS.projectName, true)
        .optional()
        .describe('Название проекта'),
      color: projectColor.optional().describe('Цвет проекта'),
      description: text(LIMITS.projectDescription)
        .optional()
        .describe('Описание проекта'),
    })
    .strict(),
  'task.create': createFields
    .extend({
      id: newIdSchema.optional(),
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
      text: text(LIMITS.checklistText, true).describe('Текст шага'),
      position: z
        .number()
        .int()
        .min(0)
        .max(LIMITS.checklistItems)
        .optional()
        .describe('Позиция шага, с нуля'),
    })
    .strict(),
  'checklist.update': z
    .object({
      taskId: idSchema,
      baseRevision: revisionSchema,
      itemId: idSchema,
      text: text(LIMITS.checklistText, true).optional().describe('Текст шага'),
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
      itemIds: z
        .array(idSchema)
        .max(LIMITS.checklistItems)
        .describe('Все шаги в нужном порядке'),
    })
    .strict(),
  'comment.add': z
    .object({
      taskId: idSchema,
      id: idSchema.optional(),
      text: text(LIMITS.commentText, true).describe(
        'Комментарий или отчёт агента',
      ),
    })
    .strict(),
  'comment.remove': z.object({ commentId: idSchema }).strict(),
  'appearance.update': z
    .object({
      baseRevision: revisionSchema,
      mode: appearanceModeSchema.optional(),
      skinId: skinIdSchema.optional(),
      hideP3: z
        .boolean()
        .optional()
        .describe('Скрывать P3 на доске и в списке'),
    })
    .strict()
    .refine(
      (v) =>
        v.mode !== undefined ||
        v.skinId !== undefined ||
        v.hideP3 !== undefined,
      'Укажите режим, скин или фильтр P3',
    ),
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
export type CommandName = keyof typeof schemas;
export const commandNames = Object.keys(schemas) as [
  CommandName,
  ...CommandName[],
];
export const commandNameSchema = z.enum(commandNames).describe('Имя команды');
const envelopeFields = {
  operationId: idSchema,
  generation: idSchema,
  dryRun: z.boolean().optional().describe('Проверить без записи'),
  confirmOwnerFields: z
    .boolean()
    .optional()
    .describe(
      'Агент подтверждает поручение владельца: команда меняет поля из ownerFields. Без true такая команда получает 403. Флаг остаётся в результате операции как след, поручение он не доказывает.',
    ),
};
type Member<K extends CommandName, E extends z.ZodRawShape> = z.ZodObject<
  E & { command: z.ZodLiteral<K>; payload: (typeof schemas)[K] },
  z.core.$strict
>;
type Members<E extends z.ZodRawShape> = {
  [K in CommandName]: Member<K, E>;
}[CommandName];
// The union members are built from `schemas`, so adding a payload schema adds
// the member everywhere. The only cast: `map` cannot express that the member
// for `name` carries the payload schema of that same name; the resulting type
// is checked against the explicit `Command` type in tests/unit/shared.test.ts.
const members = <E extends z.ZodRawShape>(extra: E) =>
  commandNames.map((name) =>
    z
      .object({
        ...extra,
        command: z.literal(name).describe('Имя команды'),
        payload: schemas[name].describe('Параметры команды'),
      })
      .strict(),
  ) as unknown as [Members<E>, ...Members<E>[]];
export const commandSchema = z
  .discriminatedUnion('command', members({}))
  .meta({ id: 'Command' });
export const commandEnvelopeSchema = z
  .discriminatedUnion('command', members(envelopeFields))
  .meta({ id: 'CommandEnvelope' });
export const batchEnvelopeSchema = z
  .object({
    ...envelopeFields,
    commands: z
      .array(commandSchema)
      .min(1)
      .max(LIMITS.batchCommands)
      .describe(`Атомарный пакет до ${LIMITS.batchCommands} команд`),
  })
  .strict()
  .meta({ id: 'BatchEnvelope' });
export const operationEnvelopeSchema = z.union([
  commandEnvelopeSchema,
  batchEnvelopeSchema,
]);
export type Command = z.infer<typeof commandSchema>;
export type CommandOf<K extends CommandName> = Extract<Command, { command: K }>;
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export type BatchEnvelope = z.infer<typeof batchEnvelopeSchema>;
