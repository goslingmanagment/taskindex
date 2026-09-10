import { createRoute } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { idSchema } from '../../shared/schemas.js';
import {
  eventSchema,
  eventsPageSchema,
  pageSchema,
} from '../../shared/domain-schemas.js';
import { fail } from '../../shared/errors.js';
import { LIMITS } from '../../shared/limits.js';
import {
  generation,
  latestSeq,
  readEvents,
  readEventsForRecord,
  taskExists,
} from '../db.js';
import { idParam, json, pageQuery, readErrors } from '../http/openapi.js';
import { keyField } from '../http/pagination.js';
import type { Deps, Env } from '../http/deps.js';

export const registerHistoryRoutes = <T extends OpenAPIHono<Env>>(
  app: T,
  deps: Deps,
) => {
  const { db, checkGeneration, paging } = deps;
  return app
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/events',
        operationId: 'listEvents',
        summary: 'События после seq',
        description:
          'Страница событий по возрастанию seq внутри одного поколения; more означает, что есть ещё.',
        tags: ['events'],
        request: {
          query: z.object({
            generation: idSchema.describe(
              'Поколение базы; при несовпадении 409 generation_changed',
            ),
            since: z.coerce
              .number()
              .int()
              .min(0)
              .default(0)
              .describe('Последнее известное событие; 0 — с начала'),
            limit: z.coerce
              .number()
              .int()
              .min(1)
              .max(LIMITS.pageSize)
              .default(LIMITS.pageSize)
              .describe(`Размер страницы 1-${LIMITS.pageSize}`),
          }),
        },
        responses: { 200: json(eventsPageSchema), ...readErrors },
      }),
      (c) => {
        const q = c.req.valid('query');
        checkGeneration(q.generation);
        const events = readEvents(db, q.since, q.limit + 1);
        return c.json(
          {
            generation: generation(db),
            latestSeq: latestSeq(db),
            more: events.length > q.limit,
            events: events.slice(0, q.limit),
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/tasks/{id}/history',
        operationId: 'getTaskHistory',
        summary: 'История изменений задачи',
        description:
          'События задачи по возрастанию seq; курсор продолжает с позиции seq.',
        tags: ['tasks'],
        request: { params: idParam, query: pageQuery },
        responses: {
          200: json(pageSchema(eventSchema).meta({ id: 'EventPage' })),
          ...readErrors,
        },
      }),
      (c) => {
        const id = c.req.valid('param').id;
        if (!taskExists(db, id)) fail('not_found', 'Задача не найдена.');
        const q = c.req.valid('query');
        const identity = `history:${id}`;
        const key = paging.cursorKey(q, identity);
        const rows = readEventsForRecord(db, 'task', id, 0, {
          afterSeq: key ? keyField(key, 'seq', 'number') : 0,
          limit: q.limit + 1,
        });
        return c.json(
          paging.slicePage(rows, q, identity, (e) => ({ seq: e.seq })),
          200,
        );
      },
    );
};
