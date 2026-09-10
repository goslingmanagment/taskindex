import { createRoute } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { contextSchema } from '../../shared/domain-schemas.js';
import { buildContext } from '../context.js';
import { json, readErrors } from '../http/openapi.js';
import type { Deps, Env } from '../http/deps.js';

export const registerContextRoutes = <T extends OpenAPIHono<Env>>(
  app: T,
  deps: Deps,
) =>
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/context',
      operationId: 'getContext',
      summary: 'Справочник для агента',
      description:
        'Актор запроса, агенты, области, статусы, проекты, JSON Schema полей задачи и параметров команд, правила и счётчики.',
      tags: ['context'],
      responses: { 200: json(contextSchema), ...readErrors },
    }),
    (c) => c.json(buildContext(deps, c.get('actor')), 200),
  );
