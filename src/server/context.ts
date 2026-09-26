import { z } from 'zod';
import { AREAS, STATUSES, FORMAT_VERSION } from '../shared/model.js';
import { PRIORITIES } from '../shared/labels.js';
import type { Actor, Context } from '../shared/model.js';
import { commandPayloadSchemas, commandNames } from '../shared/schemas.js';
import { taskSchema } from '../shared/domain-schemas.js';
import { focusGroups, todayInTimezone } from '../shared/queries.js';
import { generation, latestSeq } from './db.js';
import { listAgents } from './admin.js';
import type { Deps } from './http/deps.js';

// `.meta({ id })` makes z.toJSONSchema return `{ $ref, $defs }`; /api/context
// promises an inline object for `fields`, so the root definition is unwrapped.
function inlineJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $ref, $defs, ...rest } = z.toJSONSchema(schema) as {
    $ref?: string;
    $defs?: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
  };
  if (!$ref || !$defs) return { ...rest, ...($defs ? { $defs } : {}) };
  const id = $ref.replace('#/$defs/', '');
  const { [id]: root, ...others } = $defs;
  return {
    ...rest,
    ...root,
    ...(Object.keys(others).length ? { $defs: others } : {}),
  };
}

// What an agent must know before its first command: the model, the catalogues,
// the JSON Schema of every payload and the rules that are not expressible in a
// schema.
const RULES = [
  'Проект выбирается по описанию; при сомнении оставьте без проекта.',
  'Сначала поиск по origin, затем по тексту, затем создание.',
  'sync требует упорядоченную версию самого источника; время наблюдения и ETag её не заменяют.',
  'После conflict перечитайте current и оцените смысл поручения; повторяйте неизвестный исход только с прежним operationId.',
  'Undo: владелец отменяет любые операции; агент не отменяет операции с событиями владельца (403), операции других агентов отменяет в рамках scope, чужой комментарий — нет. Ошибку владельца не исправляйте отменой: сообщите комментарием. Отмена правки поля из ownerFields возвращает значение владельца и флага не требует; отмена такой отмены пишет правку снова и, как прямая команда, требует confirmOwnerFields: true.',
  'Undo не трогает версию источника и список ownerFields.',
  'focus и focusPosition ставит и снимает только владелец: прямая команда агента с ними получает 403, в sync поле focus пропускается (skipped: owner). focusPosition ({first: true} | {after: id} | {before: id}) задаёт место на столе Focus, focus: true без позиции — в конец; статус done и архив снимают фокус.',
  'Приоритет: p1 горит, p2 обычная (по умолчанию), p3 когда-нибудь. Порядок карточек в колонке остаётся ручным (orderKey); приоритет только помечает и фильтрует, его выставляет владелец словами. Метки только из каталога labels этого ответа, до 8 без повторов. closes — слаг проблемы из /OS/PROBLEMS.md, которую закрывает задача.',
  'После касания владельца task.sync не меняет priority (как статус, архив, область и проект). Прямая команда над priority, labels или closes из ownerFields требует confirmOwnerFields: true.',
  'Решения владельца (ownerFields, а также статус, архив, проект и область после его касания) sync не перезаписывает. Прямая команда агента, меняющая поле из ownerFields, требует в конверте confirmOwnerFields: true (иначе 403); флаг остаётся в результате операции как след поручения, доказательством он не является.',
  'Шаг это запись со своей revision (checklist[].revision задачи): baseRevision команд checklist.update|remove|move|promote это ревизия шага, checklist.add и reorder ревизии не требуют. Защита владельца действует по шагу: без флага агент отмечает шаги выполненными, пишет итог (result), добавляет новые и правит шаги, которых владелец не касался; переименование, удаление, перестановка шага владельца и снятие его отметки требуют confirmOwnerFields: true. task.save с checklist меняет только перечисленные шаги (removed: true убирает шаг), неперечисленные не трогает. checklist.promote выносит шаг в отдельную задачу той же области и направления и связывает их (linkedTaskId). Источник (task.sync) пишет шаги только при создании задачи.',
  'Оформление (режим, скин и hideP3) меняет только владелец командой appearance.update; агент читает его в /api/appearance и в снимке.',
  'Предложения агентов (proposal.*) лежат отдельно от доски: /api/proposals. Ключ scope propose читает всё и пишет только proposal.create и proposal.deliver. proposal.accept и proposal.reject выполняет агент с tasks или write по слову владельца; accept выполняет сохранённую команду задачи (с правкой patch) с подтверждёнными полями владельца, а если задача изменилась после предложения, предложение становится stale (task: null), задача не меняется. Принятие отменяется только целиком: undo --operation.',
  'Календарные даты считаются в часовом поясе пространства.',
  'Focus: выбранное, новое от агентов, срок, дата возврата; каждая задача один раз.',
  'Журнал операций читайте по operationSeq (after= в /api/operations, sinceOp= в /api/digest): так видны отказы и операции без событий; since по событиям их не показывает.',
];

export function buildContext(deps: Deps, actor: Actor): Context {
  const { db, now, timezone, projection } = deps;
  const state = projection.read();
  const today = todayInTimezone(timezone(), now());
  return {
    formatVersion: FORMAT_VERSION,
    generation: generation(db),
    seq: latestSeq(db),
    today,
    timezone: timezone(),
    me: actor,
    agents: listAgents(db),
    areas: [...AREAS],
    statuses: [...STATUSES],
    projects: state.projects,
    priorities: [...PRIORITIES],
    labels: state.labels
      .filter((l) => !l.archivedAt)
      .map(({ id, name, color, description }) => ({
        id,
        name,
        color,
        description,
      })),
    originSystems: [
      ...new Set(
        state.tasks.flatMap((t) => (t.originSystem ? [t.originSystem] : [])),
      ),
    ],
    fields: inlineJsonSchema(taskSchema),
    commands: commandNames.map((command) => ({
      command,
      payload: z.toJSONSchema(commandPayloadSchemas[command]),
    })),
    rules: RULES,
    counts: {
      tasks: state.tasks.length,
      archived: state.tasks.filter((t) => t.archived).length,
      projects: state.projects.length,
      areas: Object.fromEntries(
        AREAS.map((a) => [
          a.id,
          state.tasks.filter((t) => t.area === a.id).length,
        ]),
      ),
      statuses: Object.fromEntries(
        STATUSES.map((s) => [
          s.id,
          state.tasks.filter((t) => t.status === s.id).length,
        ]),
      ),
      focus: focusGroups(state.tasks, today).map((g) => ({
        id: g.id,
        count: g.tasks.length,
      })),
    },
    links: {
      openapi: '/api/openapi.json',
      snapshot: '/api/snapshot',
      events: '/api/events',
      export: '/api/export',
    },
  };
}
