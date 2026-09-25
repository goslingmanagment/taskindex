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
const stepRevisionSchema = revisionSchema.describe(
  'Ревизия шага из checklist задачи (revision шага, не задачи)',
);
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
// A step as a client writes it (task.create, task.save, task.sync): the
// server keeps steps as records of their own (TI-095) and turns this list
// into per-step changes; `revision` is the step's base for task.save, a new
// step has none.
const checklistInputItemSchema = z
  .object({
    id: idSchema.optional().describe('Идентификатор шага; у нового шага любой'),
    text: text(LIMITS.checklistText, true).describe('Текст шага'),
    done: z.boolean().optional().describe('Шаг выполнен'),
    result: text(LIMITS.stepResult).optional().describe('Итог шага'),
    revision: revisionSchema
      .optional()
      .describe('Ревизия шага, от которой идёт правка (task.save)'),
    removed: z
      .boolean()
      .optional()
      .describe(
        'Убрать этот шаг (task.save); шаги, которых нет в списке, не трогаются',
      ),
  })
  .strict();
export const checklistSchema = z
  .array(checklistInputItemSchema)
  .max(LIMITS.checklistItems)
  .refine((v) => {
    const ids = v.flatMap((x) => (x.id ? [x.id] : []));
    return new Set(ids).size === ids.length;
  }, 'Шаги должны иметь разные идентификаторы')
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
// Agent proposals (spec 2026-09-25, plan 2026-09-25-proposals-phase1 §1): an
// exact task command waiting for the owner's «да». A proposal is addressed by
// its number among the shown ones or by its id, so an id of one or two digits
// is refused.
export const PROPOSAL_KINDS = ['new_task', 'task_change'] as const;
export const PROPOSAL_STATUSES = [
  'queued',
  'shown',
  'accepted',
  'rejected',
  'expired',
  'stale',
] as const;
export const PROPOSAL_COMMANDS = [
  'task.create',
  'task.update',
  'task.move',
  'task.archive',
] as const;
export const proposalKindSchema = z
  .enum(PROPOSAL_KINDS)
  .describe('new_task — новая задача, task_change — изменение задачи на доске');
export const proposalRankSchema = z
  .union([z.literal(1), z.literal(2), z.literal(3)])
  .describe(
    '1 срочное (кто-то ждёт владельца или срок в пределах 3 дней), 2 обычное, 3 уборка доски',
  );
export const proposalCommandSchema = z
  .object({
    command: z
      .enum(PROPOSAL_COMMANDS)
      .describe('Команда, которая выполнится по «да»'),
    payload: z
      .record(z.string(), z.unknown())
      .describe(
        'Полный payload этой команды; проверяется её схемой (taskindex context → commands)',
      ),
  })
  .strict()
  .describe(
    'Точная команда: task.create для новой задачи; task.update, task.move (только в done) или task.archive для изменения',
  );
export const evidenceSchema = z
  .object({
    source: z
      .enum(['session', 'telegram', 'board'])
      .describe('Источник: сессия агента, Телеграм или доска'),
    ref: text(LIMITS.proposalEvidenceRef, true).describe(
      'Где именно: сессия, чат, задача',
    ),
    at: z
      .union([dateSchema.unwrap(), z.iso.datetime({ offset: true })])
      .describe('Дата YYYY-MM-DD или момент ISO'),
    quote: text(LIMITS.proposalQuote, true).describe('Цитата из источника'),
  })
  .strict();
export const proposalPatchSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'Правка владельца поверх payload предложения (глубина одна: поля payload); ключ command меняет вид действия изменения задачи',
  );
const proposalRefSchema = idSchema.describe(
  'Номер среди показанных сейчас (1–15) или идентификатор предложения',
);
const proposalIdSchema = newIdSchema.refine(
  (id) => !/^\d\d?$/.test(id),
  'Одна-две цифры это номер показанного предложения, не идентификатор',
);
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
  // Steps are records of their own (TI-095): `baseRevision` of update,
  // remove, move and promote is the step's revision from the task's
  // checklist; add and reorder need none (the flag of older CLIs is accepted
  // and ignored).
  'checklist.add': z
    .object({
      taskId: idSchema,
      baseRevision: revisionSchema
        .optional()
        .describe('Не используется: добавление шага ревизии не требует'),
      id: idSchema.optional(),
      text: text(LIMITS.checklistText, true).describe('Текст шага'),
      position: z
        .number()
        .int()
        .min(0)
        .max(LIMITS.checklistItems)
        .optional()
        .describe('Позиция шага среди шагов задачи, с нуля'),
    })
    .strict(),
  'checklist.update': z
    .object({
      taskId: idSchema,
      baseRevision: stepRevisionSchema,
      itemId: idSchema,
      text: text(LIMITS.checklistText, true).optional().describe('Текст шага'),
      done: z.boolean().optional().describe('Шаг выполнен'),
      result: text(LIMITS.stepResult)
        .optional()
        .describe('Итог шага: что вышло, ссылка на PR или файл'),
      linkedTaskId: idSchema
        .nullable()
        .optional()
        .describe('Задача, в которую вырос шаг, или null'),
    })
    .strict()
    .refine(
      (v) =>
        v.text !== undefined ||
        v.done !== undefined ||
        v.result !== undefined ||
        v.linkedTaskId !== undefined,
      'Укажите текст, отметку, итог или связанную задачу',
    ),
  'checklist.remove': z
    .object({
      taskId: idSchema,
      baseRevision: stepRevisionSchema,
      itemId: idSchema,
    })
    .strict(),
  'checklist.move': z
    .object({
      taskId: idSchema,
      baseRevision: stepRevisionSchema,
      itemId: idSchema,
      before: idSchema.optional().describe('Поставить перед этим шагом'),
      after: idSchema.optional().describe('Поставить после этого шага'),
    })
    .strict()
    .refine((v) => !!v.before !== !!v.after, 'Выберите одного соседа'),
  'checklist.reorder': z
    .object({
      taskId: idSchema,
      baseRevision: revisionSchema
        .optional()
        .describe('Не используется: перестановка ревизии не требует'),
      itemIds: z
        .array(idSchema)
        .max(LIMITS.checklistItems)
        .describe('Все шаги в нужном порядке'),
    })
    .strict(),
  'checklist.promote': z
    .object({
      taskId: idSchema,
      baseRevision: stepRevisionSchema,
      itemId: idSchema,
      id: newIdSchema.optional().describe('Идентификатор новой задачи'),
      title: text(LIMITS.taskTitle, true)
        .optional()
        .describe('Название новой задачи; по умолчанию текст шага'),
      priority: prioritySchema.optional(),
      projectId: idSchema
        .nullable()
        .optional()
        .describe('Направление новой задачи; по умолчанию как у исходной'),
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
  // Agent proposals: the night shift creates and shows them (scope propose),
  // an agent with tasks or write accepts or rejects them on the owner's word.
  'proposal.create': z
    .object({
      id: proposalIdSchema.optional(),
      kind: proposalKindSchema,
      taskId: idSchema
        .nullable()
        .optional()
        .describe(
          'Задача изменения (task_change), равна payload.id команды; у новой задачи нет',
        ),
      baseRevision: revisionSchema
        .nullable()
        .optional()
        .describe(
          'Revision задачи, которую видел автор (task_change), равна payload.baseRevision команды',
        ),
      command: proposalCommandSchema,
      reason: text(LIMITS.proposalReason, true).describe(
        'Почему предлагается, для человека',
      ),
      evidence: z
        .array(evidenceSchema)
        .min(1)
        .max(LIMITS.proposalEvidence)
        .describe(
          `Доказательства, 1–${LIMITS.proposalEvidence}: {source, ref, at, quote}`,
        ),
      fingerprint: text(LIMITS.proposalFingerprint, true).describe(
        'Ключ повтора: предложение с тем же отпечатком (в любом статусе) заново не создаётся',
      ),
      rank: proposalRankSchema,
    })
    .strict()
    .superRefine((draft, ctx) => {
      for (const issue of proposalCommandIssues(draft))
        ctx.addIssue({
          code: 'custom',
          path: issue.path,
          message: issue.message,
        });
    }),
  'proposal.deliver': z
    .object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(LIMITS.proposalsPerDay)
        .optional()
        .describe(
          `Сколько показать сегодня, 1–${LIMITS.proposalsPerDay} (по умолчанию ${LIMITS.proposalsPerDay})`,
        ),
    })
    .strict(),
  'proposal.accept': z
    .object({ ref: proposalRefSchema, patch: proposalPatchSchema.optional() })
    .strict(),
  'proposal.reject': z
    .object({
      ref: proposalRefSchema,
      reason: text(LIMITS.proposalReason, true)
        .optional()
        .describe('Причина отказа словами владельца'),
    })
    .strict(),
};
export const commandPayloadSchemas = schemas;
type ProposalDraft = {
  kind: (typeof PROPOSAL_KINDS)[number];
  taskId?: string | null;
  baseRevision?: number | null;
  command: z.infer<typeof proposalCommandSchema>;
};
type ProposalIssue = { path: (string | number)[]; message: string };
// The rules of a proposed command (plan §1.1) beyond the command's own schema:
// the kind matches the command, a change names its task and revision, a move
// only finishes, a card note fits the morning message and focus stays the
// owner's. A new task carries nothing the morning message does not show:
// no place on the board, no link to an outside source (its dedupe could turn
// «да» into a pointer to another task, and task.sync would later rewrite the
// card) and no step ticked or reported (the tick would credit the accepting
// agent with work it did not do). The id stays: it names the record and
// changes nothing the owner gets. Checked on proposal.create and again on the
// owner's patch.
export function proposalCommandIssues(draft: ProposalDraft): ProposalIssue[] {
  const { command, payload } = draft.command;
  const issues: ProposalIssue[] = [];
  const add = (path: (string | number)[], message: string) =>
    issues.push({ path, message });
  const parsed = schemas[command].safeParse(payload);
  if (!parsed.success)
    for (const issue of parsed.error.issues)
      add(
        [
          'command',
          'payload',
          ...issue.path.map((key) =>
            typeof key === 'number' ? key : String(key),
          ),
        ],
        issue.message,
      );
  for (const key of ['focus', 'focusPosition'])
    if (Object.hasOwn(payload, key))
      add(
        ['command', 'payload', key],
        'Фокус ставит только владелец: в предложении его нет',
      );
  if (command === 'task.create') {
    if (
      typeof payload.note === 'string' &&
      payload.note.trim().length > LIMITS.proposalNote
    )
      add(
        ['command', 'payload', 'note'],
        `Заметка предложенной задачи не длиннее ${LIMITS.proposalNote} символов`,
      );
    if (Object.hasOwn(payload, 'position'))
      add(
        ['command', 'payload', 'position'],
        'Место в колонке предложение не задаёт',
      );
    if (Object.hasOwn(payload, 'origin'))
      add(
        ['command', 'payload', 'origin'],
        'Связь с источником предложение не задаёт: откуда дело, говорит evidence',
      );
    const steps = Array.isArray(payload.checklist) ? payload.checklist : [];
    for (const [index, step] of steps.entries()) {
      const item = (step ?? {}) as Record<string, unknown>;
      if (item.done === true)
        add(
          ['command', 'payload', 'checklist', index, 'done'],
          'Шаг предложенной задачи открыт: отметку ставит исполнитель',
        );
      if (typeof item.result === 'string' && item.result.trim())
        add(
          ['command', 'payload', 'checklist', index, 'result'],
          'Итог шага пишет исполнитель: в предложении его нет',
        );
    }
  }
  if (draft.kind === 'new_task') {
    if (command !== 'task.create')
      add(
        ['command', 'command'],
        'Новая задача предлагается командой task.create',
      );
    if (draft.taskId != null) add(['taskId'], 'У новой задачи нет taskId');
    if (draft.baseRevision != null)
      add(['baseRevision'], 'У новой задачи нет baseRevision');
    return issues;
  }
  if (command === 'task.create') {
    add(
      ['command', 'command'],
      'Изменение задачи предлагается командой task.update, task.move или task.archive',
    );
    return issues;
  }
  if (draft.taskId != null && payload.id !== draft.taskId)
    add(['taskId'], 'taskId должен совпадать с payload.id команды');
  if (draft.baseRevision != null && payload.baseRevision !== draft.baseRevision)
    add(
      ['baseRevision'],
      'baseRevision должна совпадать с payload.baseRevision команды',
    );
  if (command === 'task.move') {
    if (payload.status !== 'done')
      add(
        ['command', 'payload', 'status'],
        'Предложение переносит задачу только в done',
      );
    for (const key of ['before', 'after'])
      if (Object.hasOwn(payload, key))
        add(
          ['command', 'payload', key],
          'Место в колонке предложение не задаёт',
        );
  }
  return issues;
}
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
