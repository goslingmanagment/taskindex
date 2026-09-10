import { createRoute } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  operationSummarySchema,
  pageSchema,
  storedOperationSchema,
} from '../../shared/domain-schemas.js';
import { fail } from '../../shared/errors.js';
import { readOperation, readOperations } from '../db.js';
import {
  idParam,
  json,
  pageQuery,
  readErrors,
  stripStored,
} from '../http/openapi.js';
import type { Deps, Env } from '../http/deps.js';

export const registerOperationRoutes = <T extends OpenAPIHono<Env>>(
  app: T,
  deps: Deps,
) => {
  const { db, page } = deps;
  return app
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/operations',
        operationId: 'listOperations',
        summary: 'Журнал операций',
        description:
          'Два курсора. after — позиция журнала operationSeq: страница по возрастанию, включает отказы и операции без событий, следующая страница — after = operationSeq последней. since/until — окно по событиям (lastSeq), новые сверху; операции без событий в окно since > 0 не входят. Без after и since — все операции, новые сверху.',
        tags: ['operations'],
        request: {
          query: pageQuery.extend({
            actor: z
              .string()
              .optional()
              .describe('Только операции этого актора (owner или agent:<id>)'),
            after: z.coerce
              .number()
              .int()
              .min(0)
              .optional()
              .describe(
                'Курсор журнала: операции с operationSeq больше указанного, по возрастанию',
              ),
            since: z.coerce
              .number()
              .int()
              .min(0)
              .optional()
              .describe(
                'Окно по событиям: последнее событие операции позже since; 0 или отсутствие — все операции',
              ),
            until: z.coerce
              .number()
              .int()
              .min(0)
              .optional()
              .describe(
                'Верхняя граница окна по событиям: lastSeq не больше until',
              ),
          }),
        },
        responses: {
          200: json(
            pageSchema(operationSummarySchema).meta({ id: 'OperationPage' }),
          ),
          ...readErrors,
        },
      }),
      (c) => {
        const q = c.req.valid('query');
        const {
          cursor: _cursor,
          limit: _limit,
          generation: _generation,
          ...identity
        } = q;
        const rows = readOperations(db)
          .filter(
            (o) =>
              (!q.actor || o.actorId === q.actor) &&
              (q.after === undefined || o.operationSeq > q.after) &&
              (!q.since || (o.lastSeq ?? 0) > q.since) &&
              (q.until === undefined || (o.lastSeq ?? 0) <= q.until),
          )
          .map(stripStored);
        const ordered = q.after === undefined ? rows.reverse() : rows;
        return c.json(
          page(ordered, q, `operations:${JSON.stringify(identity)}`),
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/operations/{id}',
        operationId: 'getOperation',
        summary: 'Сохранённый результат операции',
        description:
          '404 означает, что сервер такой операции не знает: конверт можно отправить заново с тем же operationId.',
        tags: ['operations'],
        request: { params: idParam },
        responses: { 200: json(storedOperationSchema), ...readErrors },
      }),
      (c) => {
        const o = readOperation(db, c.req.valid('param').id);
        if (!o) fail('not_found', 'Операция пока неизвестна серверу.');
        const { commandHash: _hash, ...record } = o;
        return c.json(record, 200);
      },
    );
};
