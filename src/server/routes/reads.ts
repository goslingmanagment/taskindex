import { createRoute } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { areaSchema, statusSchema } from '../../shared/schemas.js';
import {
  appearanceSchema,
  commentSchema,
  exportSchema,
  meSchema,
  pageSchema,
  projectsResponseSchema,
  snapshotSchema,
  taskSchema,
} from '../../shared/domain-schemas.js';
import { fail } from '../../shared/errors.js';
import { queryTasks, todayInTimezone } from '../../shared/queries.js';
import {
  generation,
  latestSeq,
  readComments,
  readProjects,
  readState,
  readTask,
  readTaskByOrigin,
  taskExists,
  withRead,
} from '../db.js';
import { exportWorkspace } from '../admin.js';
import {
  flag,
  idParam,
  json,
  pageQuery,
  readErrors,
  truthy,
} from '../http/openapi.js';
import type { Deps, Env } from '../http/deps.js';

export const registerReadRoutes = <T extends OpenAPIHono<Env>>(
  app: T,
  deps: Deps,
) => {
  const { db, version, now, timezone, page } = deps;
  return (
    app
      .openapi(
        createRoute({
          method: 'get',
          path: '/api/me',
          operationId: 'getMe',
          summary: 'Кто я и текущее поколение',
          description:
            'Актор ключа или сессии плюс generation и seq: лёгкий запрос перед записью без /api/context.',
          tags: ['context'],
          responses: { 200: json(meSchema), ...readErrors },
        }),
        (c) =>
          c.json(
            {
              ...c.get('actor'),
              generation: generation(db),
              seq: latestSeq(db),
            },
            200,
          ),
      )
      .openapi(
        createRoute({
          method: 'get',
          path: '/api/snapshot',
          operationId: 'getSnapshot',
          summary: 'Полный снимок проектов и задач',
          description:
            'Все задачи, включая архив, с generation и seq для последующего чтения событий. schemaVersion — версия схемы сервера.',
          tags: ['tasks'],
          responses: { 200: json(snapshotSchema), ...readErrors },
        }),
        (c) =>
          c.json(
            withRead(db, () => {
              const state = readState(db);
              return {
                generation: generation(db),
                seq: latestSeq(db),
                schemaVersion: version,
                today: todayInTimezone(timezone(), now()),
                timezone: timezone(),
                projects: state.projects,
                tasks: state.tasks,
                appearance: state.appearance[0],
              };
            }),
            200,
          ),
      )
      .openapi(
        createRoute({
          method: 'get',
          path: '/api/appearance',
          operationId: 'getAppearance',
          summary: 'Предпочтение оформления владельца',
          description:
            'Режим (system, light, dark), выбранный скин и revision для appearance.update. Пространство без выбора отвечает значением по умолчанию с revision 1.',
          tags: ['context'],
          responses: { 200: json(appearanceSchema), ...readErrors },
        }),
        (c) => c.json(readState(db).appearance[0]!, 200),
      )
      .openapi(
        createRoute({
          method: 'get',
          path: '/api/tasks',
          operationId: 'listTasks',
          summary: 'Поиск и фильтр задач',
          description:
            'Страницы стабильны внутри одного seq: изменение данных между страницами даёт 409 conflict, начните заново.',
          tags: ['tasks'],
          request: {
            query: pageQuery.extend({
              q: z
                .string()
                .optional()
                .describe('Слова поиска по названию, заметке, проекту и шагам'),
              area: areaSchema.optional(),
              project: z
                .string()
                .optional()
                .describe('Идентификатор проекта, all или none'),
              status: statusSchema.optional(),
              archived: flag('Только архив'),
              focus: flag('Только выбранные владельцем'),
              today: flag(
                'Только задачи на сегодня: срок или дата возврата не позже сегодняшнего дня',
              ),
              hasFollowUp: flag('Только задачи с датой возврата'),
            }),
          },
          responses: {
            200: json(pageSchema(taskSchema).meta({ id: 'TaskPage' })),
            ...readErrors,
          },
        }),
        (c) => {
          const q = c.req.valid('query');
          const state = readState(db);
          const values = queryTasks(
            state.tasks,
            state.projects,
            {
              ...q,
              archived: truthy(q.archived),
              focus: q.focus === undefined ? undefined : truthy(q.focus),
              today: truthy(q.today),
              hasFollowUp:
                q.hasFollowUp === undefined ? undefined : truthy(q.hasFollowUp),
            },
            todayInTimezone(timezone(), now()),
          );
          const {
            cursor: _cursor,
            limit: _limit,
            generation: _generation,
            ...identity
          } = q;
          return c.json(
            page(values, q, `tasks:${JSON.stringify(identity)}`),
            200,
          );
        },
      )
      // Static path under /api/tasks: its segments are RESERVED_IDS, so no task
      // id can ever be shadowed by this route (TI-011).
      .openapi(
        createRoute({
          method: 'get',
          path: '/api/tasks/lookup/by-origin',
          operationId: 'getTaskByOrigin',
          summary: 'Задача по источнику',
          description: 'Одна задача с этим origin.system и origin.ref или 404.',
          tags: ['tasks'],
          request: {
            query: z.object({
              system: z.string().describe('Слаг источника'),
              ref: z.string().describe('Идентификатор объекта в источнике'),
            }),
          },
          responses: { 200: json(taskSchema), ...readErrors },
        }),
        (c) => {
          const q = c.req.valid('query');
          const task = readTaskByOrigin(db, q.system, q.ref);
          if (!task) fail('not_found', 'Задача источника не найдена.');
          return c.json(task, 200);
        },
      )
      .openapi(
        createRoute({
          method: 'get',
          path: '/api/tasks/{id}',
          operationId: 'getTask',
          summary: 'Задача по идентификатору',
          tags: ['tasks'],
          request: { params: idParam },
          responses: { 200: json(taskSchema), ...readErrors },
        }),
        (c) => {
          const task = readTask(db, c.req.valid('param').id);
          if (!task) fail('not_found', 'Задача не найдена.');
          return c.json(task, 200);
        },
      )
      .openapi(
        createRoute({
          method: 'get',
          path: '/api/projects',
          operationId: 'listProjects',
          summary: 'Все проекты',
          tags: ['projects'],
          responses: { 200: json(projectsResponseSchema), ...readErrors },
        }),
        (c) => c.json({ projects: readProjects(db) }, 200),
      )
      .openapi(
        createRoute({
          method: 'get',
          path: '/api/tasks/{id}/comments',
          operationId: 'listTaskComments',
          summary: 'Комментарии задачи',
          description: 'По времени создания, включая мягко удалённые.',
          tags: ['comments'],
          request: { params: idParam, query: pageQuery },
          responses: {
            200: json(pageSchema(commentSchema).meta({ id: 'CommentPage' })),
            ...readErrors,
          },
        }),
        (c) => {
          const id = c.req.valid('param').id;
          if (!taskExists(db, id)) fail('not_found', 'Задача не найдена.');
          return c.json(
            page(readComments(db, id), c.req.valid('query'), `comments:${id}`),
            200,
          );
        },
      )
      .openapi(
        createRoute({
          method: 'get',
          path: '/api/export',
          operationId: 'getExport',
          summary: 'Полный экспорт пространства',
          description:
            'Записи, журнал событий и операций с operationSeq; формат formatVersion принимает taskindex-admin import.',
          tags: ['context'],
          responses: { 200: json(exportSchema), ...readErrors },
        }),
        (c) => c.json(exportWorkspace(db), 200),
      )
  );
};
