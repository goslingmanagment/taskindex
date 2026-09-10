import { createRoute } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  healthSchema,
  operationErrorSchema,
} from '../../shared/domain-schemas.js';
import { assertSchema, generation, latestSeq } from '../db.js';
import { json } from '../http/openapi.js';
import type { Deps, Env } from '../http/deps.js';

export const registerHealthRoutes = <T extends OpenAPIHono<Env>>(
  app: T,
  deps: Deps,
) =>
  app.openapi(
    createRoute({
      method: 'get',
      path: '/health',
      operationId: 'getHealth',
      summary: 'Состояние сервера',
      description:
        'Без авторизации. 503, если база недоступна для записи. schemaVersion — версия схемы образа.',
      tags: ['health'],
      security: [],
      responses: {
        200: json(healthSchema),
        503: json(z.union([healthSchema, operationErrorSchema])),
      },
    }),
    (c) => {
      const { db, options, version, opened } = deps;
      assertSchema(db, options.migrationsDir);
      // Write probe. UPDATE without changed pages produces no commit and no
      // WAL frames (measured 2026-09-08: WAL size and PRAGMA data_version
      // unchanged after 20 calls), but still raises SQLITE_READONLY on a
      // read-only file.
      let dbWritable = true;
      try {
        db.sqlite
          .prepare("UPDATE settings SET value=value WHERE key='generation'")
          .run();
      } catch (error) {
        if (
          !String((error as { code?: unknown }).code).startsWith(
            'SQLITE_READONLY',
          )
        )
          throw error;
        dbWritable = false;
      }
      const body = {
        ok: dbWritable,
        generation: generation(db),
        seq: latestSeq(db),
        dbWritable,
        schemaVersion: version,
        build: options.build ?? 'development',
        writes: opened() ? ('open' as const) : ('held' as const),
      };
      return dbWritable ? c.json(body, 200) : c.json(body, 503);
    },
  );
