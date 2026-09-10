import { createRoute } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { focusResponseSchema } from '../../shared/domain-schemas.js';
import { fail } from '../../shared/errors.js';
import {
  focusDesk,
  focusGroups,
  todayInTimezone,
} from '../../shared/queries.js';
import { generation, latestSeq } from '../db.js';
import { json, pageQuery, readErrors } from '../http/openapi.js';
import type { Deps, Env } from '../http/deps.js';
import { focusKey } from '../http/pagination.js';

export const registerFocusRoutes = <T extends OpenAPIHono<Env>>(
  app: T,
  deps: Deps,
) => {
  const { db, now, timezone, checkGeneration, paging, projection } = deps;
  return app.openapi(
    createRoute({
      method: 'get',
      path: '/api/focus',
      operationId: 'getFocus',
      summary: 'Стол Focus и группы',
      description:
        'Без group — стол (current, next, waiting, recent, counts) и все группы целиком; с group — страница одной группы.',
      tags: ['tasks'],
      request: {
        query: pageQuery.extend({
          group: z
            .enum(['selected', 'new', 'due', 'follow-ups'])
            .optional()
            .describe('Группа Focus для постраничного чтения'),
        }),
      },
      responses: { 200: json(focusResponseSchema), ...readErrors },
    }),
    (c) => {
      const q = c.req.valid('query');
      checkGeneration(q.generation);
      const today = todayInTimezone(timezone(), now());
      const tasks = projection.read().tasks;
      const groups = focusGroups(tasks, today);
      if (q.group) {
        const selected = groups.find((g) => g.id === q.group);
        if (!selected) fail('invalid', 'Неизвестная группа Focus.');
        return c.json(
          paging.keysetPage(
            selected.tasks,
            q,
            `focus:${q.group}`,
            focusKey(q.group),
          ),
          200,
        );
      }
      return c.json(
        {
          generation: generation(db),
          seq: latestSeq(db),
          ...focusDesk(tasks, today),
          groups,
        },
        200,
      );
    },
  );
};
