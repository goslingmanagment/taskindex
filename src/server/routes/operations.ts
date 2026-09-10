import { createRoute } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  operationSummarySchema,
  pageSchema,
  storedOperationSchema,
} from '../../shared/domain-schemas.js';
import { fail } from '../../shared/errors.js';
import { readOperation, readOperationsPage } from '../db.js';
import {
  idParam,
  json,
  pageQuery,
  readErrors,
  stripStored,
} from '../http/openapi.js';
import type { Deps, Env } from '../http/deps.js';
import { keyField } from '../http/pagination.js';

export const registerOperationRoutes = <T extends OpenAPIHono<Env>>(
  app: T,
  deps: Deps,
) => {
  const { db, paging } = deps;
  return app
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/operations',
        operationId: 'listOperations',
        summary: 'Журнал операций',
        description:
          'Два курсора. after — позиция журнала operationSeq: страница по возрастанию, включает отказы и операции без событий, следующая страница — after = operationSeq последней; since/until при after не учитываются. since/until — окно по событиям (lastSeq), новые сверху; операции без событий в окно since > 0 не входят. Без after и since — все операции, новые сверху. nextCursor продолжает любую из лент с позиции operationSeq.',
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
        const name = `operations:${JSON.stringify(identity)}`;
        const key = paging.cursorKey(q, name);
        const { rows, more } = readOperationsPage(db, {
          actor: q.actor,
          after: q.after,
          since: q.since,
          until: q.until,
          cursor: key
            ? { operationSeq: keyField(key, 'operationSeq', 'number') }
            : undefined,
          limit: q.limit,
        });
        return c.json(
          paging.pageOf(rows.map(stripStored), more, name, (o) => ({
            operationSeq: o.operationSeq,
          })),
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
