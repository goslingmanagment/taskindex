import { createRoute } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { digestSchema } from '../../shared/domain-schemas.js';
import { buildDigest } from '../digest.js';
import { generationQuery, json, readErrors } from '../http/openapi.js';
import type { Deps, Env } from '../http/deps.js';

export const registerDigestRoutes = <T extends OpenAPIHono<Env>>(
  app: T,
  deps: Deps,
) =>
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/digest',
      operationId: 'getDigest',
      summary: 'Сводка: Focus, ожидания, операции, комментарии владельца',
      description:
        'Первые страницы каждого раздела с href на полный список. operations и comments берут окно по since (события) или sinceOp (журнал операций); без обоих показаны все операции.',
      tags: ['context'],
      request: {
        query: z.object({
          since: z.coerce
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
              'Окно по событиям для operations и comments; 0 или отсутствие — всё',
            ),
          sinceOp: z.coerce
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
              'Окно журнала операций: только операции с operationSeq больше указанного',
            ),
          generation: generationQuery,
        }),
      },
      responses: { 200: json(digestSchema), ...readErrors },
    }),
    (c) => {
      const q = c.req.valid('query');
      deps.checkGeneration(q.generation);
      return c.json(
        buildDigest(deps, { since: q.since ?? 0, sinceOp: q.sinceOp }),
        200,
      );
    },
  );
