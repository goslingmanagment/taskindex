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
import type { Deps, Env } from '../http/deps.js';

export const registerHistoryRoutes = <T extends OpenAPIHono<Env>>(
  app: T,
  deps: Deps,
) => {
  const { db, checkGeneration, page } = deps;
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
        description: 'События задачи по возрастанию seq.',
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
        return c.json(
          page(
            readEventsForRecord(db, 'task', id, 0),
            c.req.valid('query'),
            `history:${id}`,
          ),
          200,
        );
      },
    );
};
