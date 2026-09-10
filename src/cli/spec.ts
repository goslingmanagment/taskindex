import { commandPayloadSchemas, z } from '../shared/schemas.js';
import type { CommandName } from '../shared/model.js';

// The one declarative description of the CLI: help, argument parsing, the
// allow-list of every read and the flags of every write derive from it.

type FlagKind = 'string' | 'boolean' | 'number' | 'json';

export interface FlagSpec {
  // kebab-case, without the leading dashes
  name: string;
  kind: FlagKind;
  description: string;
  required?: boolean;
  values?: readonly string[];
  // `null` on the command line clears the field
  nullable?: boolean;
  // query parameter or payload key when it is not camelCase(name)
  key?: string;
}

export interface PositionalSpec {
  name: string;
  key: string;
  description: string;
  optional?: boolean;
  kind?: 'string' | 'number';
}

export interface ReadSpec {
  group: string;
  action?: string;
  // OpenAPI path; `{id}` is the positional argument
  route: string;
  positional?: PositionalSpec[];
  query: FlagSpec[];
  // --all, --limit, --cursor, --generation
  pageable?: boolean;
  // flags interpreted by the CLI itself, never sent as query parameters
  flags?: FlagSpec[];
  summary: string;
  example: string;
}

export interface WriteSpec {
  group: string;
  action?: string;
  command: CommandName | 'batch';
  positional: PositionalSpec[];
  summary: string;
  example: string;
}

// Commands served by the CLI without a dedicated API route.
export interface ServiceSpec {
  group: string;
  action?: string;
  positional?: PositionalSpec[];
  flags?: FlagSpec[];
  summary: string;
  example: string;
}

const flag = (
  name: string,
  kind: FlagKind,
  description: string,
  extra: Partial<FlagSpec> = {},
): FlagSpec => ({ name, kind, description, ...extra });

const generationFlag = flag(
  'generation',
  'string',
  'Поколение базы, к которому относится курсор; при смене поколения сервер отвечает generation_changed',
);

export const GLOBAL_FLAGS: FlagSpec[] = [
  flag(
    'help',
    'boolean',
    'Справка по команде, то же, что taskindex help <group> [<action>]',
  ),
];

export const PAGE_FLAGS: FlagSpec[] = [
  flag(
    'all',
    'boolean',
    'Прочитать все страницы; каждая страница печатается отдельной строкой JSON',
  ),
  flag('limit', 'number', 'Размер страницы, 1–500'),
  flag('cursor', 'string', 'nextCursor предыдущей страницы'),
  generationFlag,
];

export const WRITE_FLAGS: FlagSpec[] = [
  flag('payload', 'json', 'Поля команды одним JSON-объектом'),
  flag('file', 'string', 'Файл с JSON полей команды; «-» читает stdin'),
  flag(
    'operation-id',
    'string',
    'Идентификатор операции; повтор с тем же ID не создаёт дубля',
  ),
  flag(
    'generation',
    'string',
    'Поколение базы для конверта; без флага запрашивается у сервера',
  ),
  flag('dry-run', 'boolean', 'Проверить без записи'),
  flag(
    'confirm-owner-fields',
    'boolean',
    'Подтвердить поручение владельца: команда меняет поле из ownerFields (после ручной правки владельца); без флага сервер отвечает 403. Флаг остаётся в результате операции как след, поручение он не доказывает',
  ),
];

const sinceFlag = flag(
  'since',
  'string',
  'Читать после события с этим seq: число (для since > 0 нужен --generation исходного курсора) или `last` — seq и generation из сохранённого курсора (без курсора: 0 и текущее поколение)',
);

const commitFlag = flag(
  'commit',
  'boolean',
  'После дочитывания всех страниц (more: false) записать seq, operationSeq и generation ответа в курсор; неполный обход курсор не двигает',
);

const id = (
  name: string,
  key: string,
  description: string,
  optional = false,
): PositionalSpec => ({ name, key, description, optional });

const boolFilter = (name: string, description: string, key?: string) =>
  flag(name, 'boolean', description, key ? { key } : {});

export const READS: ReadSpec[] = [
  {
    group: 'context',
    route: '/api/context',
    query: [],
    summary: 'Модель, проекты, правила и JSON-схемы команд',
    example: 'taskindex context',
  },
  {
    group: 'appearance',
    action: 'get',
    route: '/api/appearance',
    query: [],
    summary: 'Оформление владельца: режим, скин и revision для appearance set',
    example: 'taskindex appearance get',
  },
  {
    group: 'snapshot',
    route: '/api/snapshot',
    query: [],
    summary:
      'Полный снимок задач и проектов; единственный согласованный полный список',
    example: 'taskindex snapshot',
  },
  {
    group: 'tasks',
    route: '/api/tasks',
    pageable: true,
    query: [
      flag('q', 'string', 'Поиск по тексту (-q — то же самое)'),
      flag('area', 'string', 'Область', {
        values: ['agency', 'development', 'personal'],
      }),
      flag('project', 'string', 'Проект: ID, none (без проекта) или all'),
      flag('status', 'string', 'Состояние', {
        values: ['todo', 'doing', 'waiting', 'done'],
      }),
      boolFilter('archived', 'Только архив (по умолчанию только активные)'),
      boolFilter('focus', 'Только выбранные в Focus'),
      boolFilter(
        'today',
        'Выборка «На сегодня»: срок или дата возврата не позже сегодня',
      ),
      boolFilter('has-follow-up', 'С датой возврата или без', 'hasFollowUp'),
    ],
    summary: 'Список задач с фильтрами, постранично',
    example: 'taskindex tasks --area agency --status doing --all',
  },
  {
    group: 'task',
    action: 'get',
    route: '/api/tasks/{id}',
    positional: [id('ID', 'id', 'Идентификатор задачи')],
    query: [],
    summary: 'Одна задача с revision для последующей правки',
    example: 'taskindex task get t1',
  },
  {
    group: 'task',
    action: 'history',
    route: '/api/tasks/{id}/history',
    positional: [id('ID', 'id', 'Идентификатор задачи')],
    pageable: true,
    query: [],
    summary: 'События задачи, постранично',
    example: 'taskindex task history t1 --all',
  },
  {
    group: 'task',
    action: 'find-origin',
    route: '/api/tasks/lookup/by-origin',
    query: [
      flag('system', 'string', 'Слаг источника', { required: true }),
      flag('ref', 'string', 'Идентификатор объекта в источнике', {
        required: true,
      }),
    ],
    summary: 'Задача по источнику (404, если её нет)',
    example: 'taskindex task find-origin --system telegram --ref chat:42',
  },
  {
    group: 'project',
    action: 'list',
    route: '/api/projects',
    query: [],
    summary: 'Проекты с описаниями',
    example: 'taskindex project list',
  },
  {
    group: 'comment',
    action: 'list',
    route: '/api/tasks/{id}/comments',
    positional: [id('TASK_ID', 'id', 'Идентификатор задачи')],
    pageable: true,
    query: [],
    summary: 'Комментарии задачи, постранично',
    example: 'taskindex comment list t1',
  },
  {
    group: 'activity',
    route: '/api/operations',
    pageable: true,
    query: [
      flag('actor', 'string', 'Только операции этого актора (owner, agent:ID)'),
      flag(
        'after',
        'number',
        'Курсор журнала: операции с operationSeq больше указанного, по возрастанию (видны отказы и операции без событий)',
      ),
      sinceFlag,
      flag('until', 'string', 'Не позже события с этим seq'),
    ],
    flags: [commitFlag],
    summary:
      'Лента операций всех акторов, постранично; --since last идёт по журналу операций (after=operationSeq): видны отказы и операции без изменений',
    example: 'taskindex activity --since last --all --commit',
  },
  {
    group: 'digest',
    route: '/api/digest',
    query: [
      sinceFlag,
      flag(
        'since-op',
        'number',
        'Окно по журналу операций: операции с operationSeq больше указанного',
      ),
      generationFlag,
    ],
    flags: [commitFlag],
    summary:
      'Сводка: Focus, ожидание, счётчики, комментарии владельца и операции после since (по событиям) или --since-op (по журналу операций, с отказами)',
    example: 'taskindex digest --since last',
  },
  {
    group: 'inbox',
    route: '/api/digest',
    query: [
      sinceFlag,
      flag(
        'since-op',
        'number',
        'Окно по журналу операций для сводки; на комментарии не влияет',
      ),
      generationFlag,
    ],
    flags: [commitFlag],
    summary:
      'Входящие агента: комментарии владельца после since с текстом, задачей и seq',
    example: 'taskindex inbox --since last --commit',
  },
  {
    group: 'focus',
    route: '/api/focus',
    pageable: true,
    query: [
      flag('group', 'string', 'Одна группа постранично; без флага — все', {
        values: ['selected', 'new', 'due', 'follow-ups'],
      }),
    ],
    summary: 'Группы Focus',
    example: 'taskindex focus --group due --all',
  },
  {
    group: 'events',
    route: '/api/events',
    query: [
      sinceFlag,
      flag(
        'generation',
        'string',
        'Поколение исходного курсора; обязателен при since > 0, без флага и при since 0 CLI подставляет текущее поколение сервера',
      ),
      flag('limit', 'number', 'Размер страницы, 1–500'),
    ],
    flags: [
      flag('all', 'boolean', 'Дочитать все страницы'),
      flag(
        'follow',
        'boolean',
        'Опрашивать сервер и печатать только страницы с событиями',
      ),
      flag(
        'interval',
        'number',
        'Пауза между опросами в --follow, мс (по умолчанию 1000, минимум 250)',
      ),
      commitFlag,
    ],
    summary: 'События после seq; --follow читает их опросом',
    example: 'taskindex events --since last --all --commit',
  },
  {
    group: 'operation',
    action: 'get',
    route: '/api/operations/{id}',
    positional: [id('ID', 'id', 'Идентификатор операции')],
    query: [],
    summary:
      'Сохранённый исход операции; закрывает свой конверт по тому же правилу, что и отправка',
    example: 'taskindex operation get op-1',
  },
  {
    group: 'export',
    route: '/api/export',
    query: [],
    flags: [
      flag(
        'out',
        'string',
        'Записать экспорт в новый файл (0600) вместо stdout',
      ),
    ],
    summary: 'Полный экспорт пространства',
    example: 'taskindex export --out backup.json',
  },
  {
    group: 'me',
    route: '/api/me',
    query: [],
    summary: 'Актор текущего ключа: id, label, kind, scope',
    example: 'taskindex me',
  },
  {
    group: 'openapi',
    route: '/api/openapi.json',
    query: [],
    summary: 'Документ OpenAPI сервера',
    example: 'taskindex openapi',
  },
];

// Flags that reuse a payload key under another name, because the natural
// name collides with a write flag of the envelope.
const RENAMED: Partial<Record<CommandName, Record<string, string>>> = {
  undo: { operationId: 'operation' },
};

// Payload fields the CLI fills itself when the flag is omitted, so help shows
// them optional even though the command's schema requires them. The appearance
// preference is one record with a fixed id, so `appearance set` reads its own
// baseRevision from GET /api/appearance (TI-026); a task has no such single
// address and always needs `--base-revision` from `task get`.
const AUTOFILLED: Partial<Record<CommandName, readonly string[]>> = {
  'appearance.update': ['baseRevision'],
};

export const autofilled = (command: CommandName): readonly string[] =>
  AUTOFILLED[command] ?? [];

// Descriptions for payload fields whose schema has none (nested objects).
const FIELD_DESCRIPTIONS: Record<string, string> = {
  origin:
    'Источник JSON: {"system","ref","url"?,"version"?}; version — упорядоченная версия самого источника',
  fields: 'Поля задачи JSON, как у task create',
};

const taskId = id('TASK_ID', 'taskId', 'Идентификатор задачи');
const itemId = id('ITEM_ID', 'itemId', 'Идентификатор шага');
const optionalId = (description: string) => id('ID', 'id', description, true);

const WRITE_COMMANDS: Record<CommandName, Omit<WriteSpec, 'command'>> = {
  'task.create': {
    group: 'task',
    action: 'create',
    positional: [optionalId('Идентификатор новой задачи (по умолчанию новый)')],
    summary: 'Создать задачу',
    example:
      "taskindex task create --area agency --title 'Проверить отчёт' --due 2026-09-10",
  },
  'task.sync': {
    group: 'task',
    action: 'sync',
    positional: [],
    summary:
      'Создать или обновить задачу источника; решения владельца сохраняются (applied/skipped)',
    example:
      'taskindex task sync --origin \'{"system":"telegram","ref":"chat:42","version":"123"}\' --fields \'{"area":"agency","title":"Проверить результат"}\'',
  },
  'task.update': {
    group: 'task',
    action: 'update',
    positional: [id('ID', 'id', 'Идентификатор задачи')],
    summary: 'Изменить поля задачи по прочитанной revision',
    example:
      "taskindex task update t1 --base-revision 3 --note 'Уточнение по звонку'",
  },
  'task.save': {
    group: 'task',
    action: 'save',
    positional: [id('ID', 'id', 'Идентификатор задачи')],
    summary: 'Атомарно сохранить поля, статус, позицию и чеклист',
    example:
      'taskindex task save t1 --payload \'{"baseRevision":3,"fields":{"title":"Новое"},"status":"doing"}\'',
  },
  'task.move': {
    group: 'task',
    action: 'move',
    positional: [id('ID', 'id', 'Идентификатор задачи')],
    summary: 'Сменить статус и место в колонке',
    example: 'taskindex task move t1 --base-revision 3 --status doing',
  },
  'task.archive': {
    group: 'task',
    action: 'archive',
    positional: [id('ID', 'id', 'Идентификатор задачи')],
    summary: 'Убрать задачу в архив',
    example: 'taskindex task archive t1 --base-revision 3',
  },
  'task.restore': {
    group: 'task',
    action: 'restore',
    positional: [id('ID', 'id', 'Идентификатор задачи')],
    summary: 'Вернуть задачу из архива',
    example: 'taskindex task restore t1 --base-revision 4',
  },
  'project.create': {
    group: 'project',
    action: 'create',
    positional: [
      optionalId('Идентификатор нового проекта (по умолчанию новый)'),
    ],
    summary: 'Создать проект (не отменяется)',
    example:
      "taskindex project create --area agency --name 'Входящие' --color '#123456'",
  },
  'project.update': {
    group: 'project',
    action: 'update',
    positional: [id('ID', 'id', 'Идентификатор проекта')],
    summary: 'Изменить название, цвет или описание проекта',
    example:
      "taskindex project update p1 --base-revision 2 --description 'Что складывать'",
  },
  'checklist.add': {
    group: 'checklist',
    action: 'add',
    positional: [taskId],
    summary: 'Добавить шаг',
    example:
      "taskindex checklist add t1 --base-revision 3 --text 'Позвонить' --position 0",
  },
  'checklist.update': {
    group: 'checklist',
    action: 'update',
    positional: [taskId, itemId],
    summary: 'Изменить текст шага или отметить его',
    example: 'taskindex checklist update t1 s1 --base-revision 3 --done true',
  },
  'checklist.remove': {
    group: 'checklist',
    action: 'remove',
    positional: [taskId, itemId],
    summary: 'Удалить шаг',
    example: 'taskindex checklist remove t1 s1 --base-revision 3',
  },
  'checklist.reorder': {
    group: 'checklist',
    action: 'reorder',
    positional: [taskId],
    summary: 'Переставить все шаги',
    example:
      'taskindex checklist reorder t1 --base-revision 3 --item-ids \'["s2","s1"]\'',
  },
  'comment.add': {
    group: 'comment',
    action: 'add',
    positional: [taskId],
    summary: 'Комментарий или отчёт к задаче',
    example: "taskindex comment add t1 --text 'Отчёт: проверено'",
  },
  'comment.remove': {
    group: 'comment',
    action: 'remove',
    positional: [id('COMMENT_ID', 'commentId', 'Идентификатор комментария')],
    summary: 'Удалить свой комментарий',
    example: 'taskindex comment remove c1',
  },
  'appearance.update': {
    group: 'appearance',
    action: 'set',
    positional: [],
    summary: 'Выбрать режим оформления и скин (только владелец)',
    example:
      'taskindex appearance set --base-revision 1 --mode dark --skin-id focus',
  },
  undo: {
    group: 'undo',
    positional: [
      {
        name: 'SEQ',
        key: 'seq',
        description: 'Событие для отмены (вместо --operation)',
        optional: true,
        kind: 'number',
      },
    ],
    summary: 'Отменить событие по seq или операцию целиком по --operation',
    example: 'taskindex undo --operation op-1',
  },
};

export const WRITES: WriteSpec[] = [
  ...Object.entries(WRITE_COMMANDS).map(([command, entry]) => ({
    command: command as CommandName,
    ...entry,
  })),
  {
    group: 'batch',
    command: 'batch',
    positional: [],
    summary:
      'Атомарный пакет команд из файла: массив {command,payload} или {commands:[…]}',
    example: 'taskindex batch --file commands.json --dry-run',
  },
];

export const SERVICE: ServiceSpec[] = [
  {
    group: 'operation',
    action: 'resume',
    positional: [
      id('ID', 'id', 'Конверт для повторной отправки; без ID — все свои', true),
    ],
    summary:
      'Дослать сохранённые конверты этого агента: сначала сверка исхода по operation get, затем повтор того же конверта',
    example: 'taskindex operation resume op-1',
  },
  {
    group: 'operation',
    action: 'list',
    summary:
      'Локальная очередь этого агента: ожидающие конверты и файлы *.corrupt',
    example: 'taskindex operation list',
  },
  {
    group: 'cursor',
    action: 'show',
    summary:
      'Сохранённый курсор этого агента и сервера: {generation, seq, operationSeq?, committedAt} или null',
    example: 'taskindex cursor show',
  },
  {
    group: 'cursor',
    action: 'commit',
    positional: [id('SEQ', 'seq', 'Последний полностью обработанный seq')],
    flags: [
      flag(
        'generation',
        'string',
        'Поколение курсора; без флага берётся текущее поколение сервера',
      ),
      flag(
        'operation-seq',
        'number',
        'Последний обработанный operationSeq ленты операций, если сервер его отдаёт',
      ),
    ],
    summary:
      'Записать курсор после того, как все страницы обработаны; digest/activity/events --commit делают это сами',
    example: 'taskindex cursor commit 120 --generation G',
  },
  {
    group: 'cursor',
    action: 'reset',
    summary:
      'Удалить курсор; нужно после generation_changed, затем digest заново',
    example: 'taskindex cursor reset',
  },
  {
    group: 'help',
    positional: [
      id('GROUP', 'group', 'Группа команд', true),
      id('ACTION', 'action', 'Действие группы', true),
    ],
    summary: 'Справка: обзор, группа или одна команда',
    example: 'taskindex help task create',
  },
];

export const HELP_TEXT = {
  usage:
    'taskindex <group> [<action>] [args] [flags]; справка: taskindex help [<group> [<action>]] или <command> --help',
  payloads:
    'Поля записи задаются флагами (--project-id, --waiting-for, --follow-up: kebab-case имён полей) или одним --payload JSON / --file. Флаги-объекты (--origin, --fields, --checklist, --position, --item-ids) принимают JSON. null очищает --due, --follow-up и --project-id. Полные схемы: taskindex context.',
  configuration: [
    'TASKINDEX_URL — адрес сервера',
    'TASKINDEX_TOKEN — ключ агента (через op, не в аргументах)',
    'XDG_STATE_HOME (по умолчанию ~/.local/state); конверты: $XDG_STATE_HOME/taskindex/servers/<server>/agents/<agent>/ops',
  ],
  exitCodes: {
    success: 0,
    serverOrNetwork: 1,
    arguments: 2,
    conflict: 3,
    authorization: 4,
  },
  outcomes: [
    'успех (ok: true, тот же operationId и generation) → код 0, конверт удалён',
    'окончательный отказ (ok: false, retryable: false; conflict/operation_mismatch/generation_changed/not_undoable → 3, unauthorized/forbidden → 4, иначе 1) → конверт удалён',
    'повторяемый отказ или сеть (retryable: true, 5xx, обрыв) → код 1, status: unknown, конверт сохранён',
    'неподтверждённый ответ (2xx без результата операции, чужой operationId/generation, не JSON) → код 1, code: invalid_response, status: unknown, конверт сохранён; далее operation get <id>',
  ],
};

interface JsonSchemaNode {
  type?: string | string[];
  enum?: string[];
  anyOf?: JsonSchemaNode[];
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
}

const kebab = (key: string) =>
  key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

const types = (node: JsonSchemaNode): string[] => {
  if (node.anyOf) return node.anyOf.flatMap(types);
  return Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
};

function kindOf(node: JsonSchemaNode): FlagKind {
  const found = types(node);
  if (found.includes('object') || found.includes('array')) return 'json';
  if (found.includes('boolean')) return 'boolean';
  if (found.includes('integer') || found.includes('number')) return 'number';
  return 'string';
}

const payloadFlagCache = new Map<CommandName, FlagSpec[]>();

// Flags of a write are the top-level properties of its payload schema; they
// are never listed by hand, so a new field appears in help on its own.
export function payloadFlags(command: CommandName): FlagSpec[] {
  const cached = payloadFlagCache.get(command);
  if (cached) return cached;
  const schema = z.toJSONSchema(commandPayloadSchemas[command], {
    io: 'input',
    unrepresentable: 'any',
  }) as JsonSchemaNode;
  const variants = schema.anyOf ?? [schema];
  const flags: FlagSpec[] = [];
  for (const variant of variants)
    for (const [key, node] of Object.entries(variant.properties ?? {})) {
      if (flags.some((existing) => existing.key === key)) continue;
      const name = RENAMED[command]?.[key] ?? kebab(key);
      flags.push({
        name,
        key,
        kind: kindOf(node),
        description: node.description ?? FIELD_DESCRIPTIONS[key] ?? '',
        required:
          variants.length === 1 &&
          !!variant.required?.includes(key) &&
          !AUTOFILLED[command]?.includes(key),
        ...(node.enum ? { values: node.enum } : {}),
        ...(types(node).includes('null') ? { nullable: true } : {}),
      });
    }
  payloadFlagCache.set(command, flags);
  return flags;
}

// Boolean flags may omit their value; the parser must know them up front.
export function booleanFlagNames(): Set<string> {
  const names = new Set<string>();
  const collect = (flags: FlagSpec[] | undefined) => {
    for (const entry of flags ?? [])
      if (entry.kind === 'boolean') names.add(entry.name);
  };
  collect(GLOBAL_FLAGS);
  collect(PAGE_FLAGS);
  collect(WRITE_FLAGS);
  for (const read of READS) {
    collect(read.query);
    collect(read.flags);
  }
  for (const write of WRITES)
    if (write.command !== 'batch') collect(payloadFlags(write.command));
  for (const service of SERVICE) collect(service.flags);
  return names;
}

export type Resolved =
  | { kind: 'read'; spec: ReadSpec; rest: string[] }
  | { kind: 'write'; spec: WriteSpec; rest: string[] }
  | { kind: 'service'; spec: ServiceSpec; rest: string[] };

export const commandName = (spec: {
  group: string;
  action?: string;
}): string => (spec.action ? `${spec.group} ${spec.action}` : spec.group);

// Every action of a group in help order: reads, writes, service commands.
export function groupActions(
  group: string,
): (ReadSpec | WriteSpec | ServiceSpec)[] {
  return [...READS, ...WRITES, ...SERVICE].filter(
    (spec) => spec.group === group,
  );
}

export class UnknownCommand extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = 'UnknownCommand';
  }
}

// group + action first, then a group-only command whose remaining words are
// positional arguments (`undo 42`, `task get t1`).
export function resolveCommand(positional: string[]): Resolved {
  const [group, action] = positional;
  if (!group) throw new UnknownCommand('Не задана команда', 'taskindex help');
  const all = groupActions(group);
  if (!all.length)
    throw new UnknownCommand(`Неизвестная команда: ${group}`, 'taskindex help');
  const pick = (spec: ReadSpec | WriteSpec | ServiceSpec, rest: string[]) =>
    READS.includes(spec as ReadSpec)
      ? { kind: 'read' as const, spec: spec as ReadSpec, rest }
      : WRITES.includes(spec as WriteSpec)
        ? { kind: 'write' as const, spec: spec as WriteSpec, rest }
        : { kind: 'service' as const, spec: spec as ServiceSpec, rest };
  if (action !== undefined) {
    const exact = all.find((spec) => spec.action === action);
    if (exact) return pick(exact, positional.slice(2));
  }
  const bare = all.find((spec) => spec.action === undefined);
  if (bare) return pick(bare, positional.slice(1));
  const actions = all.map((spec) => spec.action).join('|');
  throw new UnknownCommand(
    action === undefined
      ? `${group}: ожидается ${actions}`
      : `${group}: неизвестное действие ${action}; ожидается ${actions}`,
    `taskindex help ${group}`,
  );
}
