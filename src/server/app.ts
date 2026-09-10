import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { bodyLimit } from 'hono/body-limit';
import { eq } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { AREAS, STATUSES, FORMAT_VERSION } from '../shared/model.js';
import type { Actor, Entity, Page, OperationSummary } from '../shared/model.js';
import {
  z,
  idSchema,
  areaSchema,
  statusSchema,
  commandEnvelopeSchema,
  batchEnvelopeSchema,
  commandPayloadSchemas,
} from '../shared/schemas.js';
import {
  actorSchema,
  taskSchema,
  projectSchema,
  commentSchema,
  eventSchema,
  snapshotSchema,
  operationResponseSchema,
  operationErrorSchema,
  eventsPageSchema,
  pageSchema,
  operationSummarySchema,
  storedOperationSchema,
  exportSchema,
} from '../shared/domain-schemas.js';
import { DomainError, fail } from '../shared/errors.js';
import { focusGroups, queryTasks, todayInTimezone } from '../shared/queries.js';
import type { DatabaseHandle } from './db.js';
import {
  assertSchema,
  generation,
  getSetting,
  latestSeq,
  readState,
  readEvents,
  readOperations,
  schemaVersion,
} from './db.js';
import * as tables from './schema.js';
import type { Auth, Authorized } from './auth.js';
import { authorizeRequest, staticAuthorization } from './auth.js';
import { exportWorkspace, writesAreOpen } from './admin.js';
import { executeOperation } from './operations.js';
import { createEventHub, SSE_HEARTBEAT_MS } from './sse.js';
import type { Subscriber } from './sse.js';
export type AppOptions = {
  db: DatabaseHandle;
  auth?: Auth;
  // Tests may return a bare Actor: it is treated as static (never revoked).
  authorize?: (
    request: Request,
  ) => Actor | Authorized | null | Promise<Actor | Authorized | null>;
  build?: string;
  baseURL?: string;
  trustedOrigins?: string[];
  writes?: 'held' | 'open';
  deploymentId?: string;
  migrationsDir?: string;
  sseHeartbeatMs?: number;
  now?: () => string;
  ids?: () => string;
};
type Env = {
  Variables: {
    actor: Actor;
    auth: Authorized;
    operationId?: string;
    commandName?: string;
  };
};
const json = <T extends z.ZodType>(
  schema: T,
  description = 'Ответ приложения',
) => ({ description, content: { 'application/json': { schema } } });
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
  generation: idSchema.optional(),
});
const readErrors = {
  400: json(operationErrorSchema),
  401: json(operationErrorSchema),
  403: json(operationErrorSchema),
  404: json(operationErrorSchema),
  409: json(operationErrorSchema),
  503: json(operationErrorSchema),
};
const cursorSchema = z.object({
  generation: idSchema,
  seq: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  query: z.string(),
  fingerprint: z.string(),
});
const focusGroupSchema = z.object({
  id: z.enum(['selected', 'new', 'due', 'follow-ups']),
  title: z.string(),
  tasks: z.array(taskSchema),
});
const contextSchema = z.object({
  formatVersion: z.number(),
  generation: idSchema,
  seq: z.number(),
  today: z.string(),
  timezone: z.string(),
  areas: z.array(
    z.object({
      id: areaSchema,
      name: z.string(),
      color: z.string(),
      description: z.string(),
    }),
  ),
  statuses: z.array(
    z.object({
      id: statusSchema,
      name: z.string(),
      hint: z.string(),
      color: z.string(),
    }),
  ),
  projects: z.array(projectSchema),
  originSystems: z.array(z.string()),
  fields: z
    .record(z.string(), z.unknown())
    .describe('JSON Schema полей задачи'),
  commands: z.array(
    z.object({
      command: z.string(),
      payload: z
        .record(z.string(), z.unknown())
        .describe('JSON Schema параметров команды'),
    }),
  ),
  rules: z.array(z.string()),
  counts: z.object({
    tasks: z.number(),
    archived: z.number(),
    projects: z.number(),
    areas: z.record(z.string(), z.number()),
    statuses: z.record(z.string(), z.number()),
    focus: z.array(z.object({ id: z.string(), count: z.number() })),
  }),
  links: z.object({
    openapi: z.string(),
    snapshot: z.string(),
    events: z.string(),
    export: z.string(),
  }),
});
const digestSchema = z.object({
  generation: idSchema,
  seq: z.number(),
  today: z.string(),
  timezone: z.string(),
  focus: z.array(
    focusGroupSchema.extend({
      more: z.boolean(),
      nextCursor: z.string().nullable(),
      href: z.string(),
    }),
  ),
  waiting: pageSchema(taskSchema).extend({ href: z.string() }),
  counts: z.object({
    tasks: z.number(),
    archived: z.number(),
    projects: z.number(),
  }),
  operations: pageSchema(operationSummarySchema).extend({ href: z.string() }),
});
export function createApp(options: AppOptions) {
  const { db } = options;
  assertSchema(db, options.migrationsDir);
  const version = schemaVersion(options.migrationsDir);
  db.sqlite
    .prepare("UPDATE settings SET value=value WHERE key='generation'")
    .run();
  const baseURL = options.baseURL ?? 'http://localhost:3001';
  const origins = options.trustedOrigins ?? [baseURL, 'http://localhost:5173'];
  const hub = createEventHub();
  const heartbeatMs = options.sseHeartbeatMs ?? SSE_HEARTBEAT_MS;
  const now = () => options.now?.() ?? new Date().toISOString();
  const timezone = () => getSetting(db, 'timezone') ?? 'Europe/Moscow';
  const opened = () =>
    writesAreOpen(db, options.writes ?? 'open', options.deploymentId);
  const checkGeneration = (given?: string) => {
    if (given && given !== generation(db))
      fail('generation_changed', 'Поколение базы изменилось.', {
        generation: generation(db),
      });
  };
  function page<T>(
    items: T[],
    query: { limit: number; cursor?: string; generation?: string },
    identity: string,
  ): Page<T> {
    checkGeneration(query.generation);
    let offset = 0;
    let seq = latestSeq(db);
    const gen = generation(db);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(items))
      .digest('hex');
    if (query.cursor) {
      let cursor: z.infer<typeof cursorSchema>;
      try {
        cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(query.cursor, 'base64url').toString()),
        );
      } catch {
        fail('invalid', 'Неверный курсор.');
      }
      checkGeneration(cursor.generation);
      if (cursor.query !== identity)
        fail('invalid', 'Курсор относится к другому запросу.');
      if (cursor.seq !== latestSeq(db) || cursor.fingerprint !== fingerprint)
        fail('conflict', 'Данные изменились. Начните чтение страниц заново.');
      offset = cursor.offset;
      seq = cursor.seq;
    }
    const chunk = items.slice(offset, offset + query.limit);
    const more = offset + chunk.length < items.length;
    return {
      generation: gen,
      seq,
      items: chunk,
      more,
      nextCursor: more
        ? Buffer.from(
            JSON.stringify({
              generation: gen,
              seq,
              offset: offset + chunk.length,
              query: identity,
              fingerprint,
            }),
          ).toString('base64url')
        : null,
    };
  }
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json(
          {
            ok: false,
            code: 'invalid',
            message: 'Проверьте параметры запроса.',
            retryable: false,
          },
          400,
        );
    },
  });
  app.onError((error, c) => {
    if (error instanceof DomainError)
      return c.json(error.toJSON(), error.status as ContentfulStatusCode);
    if (error instanceof z.ZodError)
      return c.json(
        {
          ok: false,
          code: 'invalid',
          message: 'Проверьте поля запроса.',
          retryable: false,
        },
        400,
      );
    if (
      (error as { code?: string }).code?.startsWith('SQLITE_BUSY') ||
      (error as { code?: string }).code?.startsWith('SQLITE_READONLY')
    )
      return c.json(
        {
          ok: false,
          code: 'unavailable',
          message: 'База временно недоступна.',
          retryable: true,
        },
        503,
      );
    console.error(JSON.stringify({ code: 'internal', error: error.name }));
    return c.json(
      {
        ok: false,
        code: 'unavailable',
        message: 'Запрос не выполнен. Повторите с прежним operationId.',
        retryable: true,
      },
      503,
    );
  });
  app.use('/api/*', async (c, next) => {
    const started = Date.now();
    let rejectedStatus: number | undefined;
    try {
      if (c.req.path.startsWith('/api/auth/')) {
        // Agent keys are issued and revoked only by taskindex-admin; no HTTP
        // key management exists even if a plugin ever registers such routes.
        if (c.req.path.startsWith('/api/auth/api-key/'))
          fail(
            'not_found',
            'Ключи агентов выдаются только командой taskindex-admin.',
          );
        if (!opened() && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method))
          fail('unavailable', 'Запись закрыта на время обновления.');
        return await next();
      }
      const authorized = options.authorize
        ? await options.authorize(c.req.raw)
        : options.auth
          ? await authorizeRequest(db, options.auth, c.req.raw)
          : null;
      if (!authorized)
        fail('unauthorized', 'Войдите в TaskIndex или передайте ключ агента.');
      const auth =
        'actor' in authorized ? authorized : staticAuthorization(authorized);
      const actor = auth.actor;
      c.set('auth', auth);
      c.set('actor', actor);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
        if (
          actor.kind === 'owner' &&
          !origins.includes(c.req.header('origin') ?? '')
        )
          fail('forbidden', 'Недопустимый Origin.');
        if (!opened())
          fail('unavailable', 'Запись закрыта на время обновления.');
      }
      await next();
    } catch (error) {
      rejectedStatus = error instanceof DomainError ? error.status : 503;
      throw error;
    } finally {
      if (c.req.path.startsWith('/api/commands'))
        console.info(
          JSON.stringify({
            requestId: c.req.header('x-request-id') ?? randomUUID(),
            operationId: c.get('operationId'),
            command: c.get('commandName'),
            actor: c.get('actor')?.id,
            code: rejectedStatus ?? c.res.status,
            durationMs: Date.now() - started,
          }),
        );
    }
  });
  app.use(
    '/api/commands',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) =>
        c.json(
          {
            ok: false,
            code: 'invalid',
            message: 'Слишком большой запрос.',
            retryable: false,
          },
          400,
        ),
    }),
  );
  app.use(
    '/api/commands/batch',
    bodyLimit({
      maxSize: 4 * 1024 * 1024,
      onError: (c) =>
        c.json(
          {
            ok: false,
            code: 'invalid',
            message: 'Слишком большой пакет.',
            retryable: false,
          },
          400,
        ),
    }),
  );
  app.on(
    ['GET', 'POST'],
    '/api/auth/*',
    async (c): Promise<Response> =>
      options.auth
        ? options.auth.handler(c.req.raw)
        : c.json(
            {
              ok: false,
              code: 'unauthorized',
              message: 'Авторизация не настроена.',
              retryable: false,
            },
            401,
          ),
  );
  const api = app
    .openapi(
      createRoute({
        method: 'get',
        path: '/health',
        responses: {
          200: json(
            z.object({
              ok: z.boolean(),
              generation: idSchema,
              seq: z.number(),
              dbWritable: z.boolean(),
              schemaVersion: z.number(),
              build: z.string(),
              writes: z.enum(['held', 'open']),
            }),
          ),
          503: json(operationErrorSchema),
        },
      }),
      (c) => {
        assertSchema(db, options.migrationsDir);
        db.sqlite
          .prepare("UPDATE settings SET value=value WHERE key='generation'")
          .run();
        return c.json(
          {
            ok: true,
            generation: generation(db),
            seq: latestSeq(db),
            dbWritable: true,
            schemaVersion: version,
            build: options.build ?? 'development',
            writes: opened() ? ('open' as const) : ('held' as const),
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/me',
        responses: { 200: json(actorSchema), ...readErrors },
      }),
      (c) => c.json(c.get('actor'), 200),
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/snapshot',
        responses: { 200: json(snapshotSchema), ...readErrors },
      }),
      (c) =>
        c.json(
          db.sqlite.transaction(() => {
            const state = readState(db);
            return {
              generation: generation(db),
              seq: latestSeq(db),
              today: todayInTimezone(timezone(), now()),
              timezone: timezone(),
              projects: state.projects,
              tasks: state.tasks,
            };
          })(),
          200,
        ),
    )
    .openapi(
      createRoute({
        method: 'post',
        path: '/api/commands',
        request: {
          body: {
            required: true,
            content: { 'application/json': { schema: commandEnvelopeSchema } },
          },
        },
        responses: { 200: json(operationResponseSchema), ...readErrors },
      }),
      (c) => {
        const input = c.req.valid('json');
        c.set('operationId', input.operationId);
        c.set('commandName', input.command);
        const result = executeOperation(db, input, c.get('actor'), {
          now: now(),
          ids: options.ids,
        });
        hub.publish(result.freshEvents);
        if (result.freshOperation) hub.notifyOperations();
        return c.json(result.body, result.status as 200);
      },
    )
    .openapi(
      createRoute({
        method: 'post',
        path: '/api/commands/batch',
        request: {
          body: {
            required: true,
            content: { 'application/json': { schema: batchEnvelopeSchema } },
          },
        },
        responses: { 200: json(operationResponseSchema), ...readErrors },
      }),
      (c) => {
        const input = c.req.valid('json');
        c.set('operationId', input.operationId);
        c.set('commandName', 'batch');
        const result = executeOperation(db, input, c.get('actor'), {
          now: now(),
          ids: options.ids,
        });
        hub.publish(result.freshEvents);
        if (result.freshOperation) hub.notifyOperations();
        return c.json(result.body, result.status as 200);
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/events',
        request: {
          query: z.object({
            generation: idSchema,
            since: z.coerce.number().int().min(0).default(0),
            limit: z.coerce.number().int().min(1).max(500).default(500),
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
        path: '/api/tasks',
        request: {
          query: pageQuery.extend({
            q: z.string().optional(),
            area: areaSchema.optional(),
            project: z.string().optional(),
            status: statusSchema.optional(),
            archived: z.enum(['true', 'false', '1', '0']).optional(),
            focus: z.enum(['true', 'false', '1', '0']).optional(),
            today: z.enum(['true', 'false', '1', '0']).optional(),
            hasFollowUp: z.enum(['true', 'false', '1', '0']).optional(),
          }),
        },
        responses: { 200: json(pageSchema(taskSchema)), ...readErrors },
      }),
      (c) => {
        const q = c.req.valid('query');
        const state = readState(db);
        const values = queryTasks(
          state.tasks,
          state.projects,
          {
            ...q,
            archived: q.archived === 'true' || q.archived === '1',
            focus:
              q.focus === undefined
                ? undefined
                : q.focus === 'true' || q.focus === '1',
            today: q.today === 'true' || q.today === '1',
            hasFollowUp:
              q.hasFollowUp === undefined
                ? undefined
                : q.hasFollowUp === 'true' || q.hasFollowUp === '1',
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
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/tasks/by-origin',
        request: { query: z.object({ system: z.string(), ref: z.string() }) },
        responses: { 200: json(taskSchema), ...readErrors },
      }),
      (c) => {
        const q = c.req.valid('query');
        const task = readState(db).tasks.find(
          (t) => t.originSystem === q.system && t.originRef === q.ref,
        );
        if (!task) fail('not_found', 'Задача источника не найдена.');
        return c.json(task, 200);
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/tasks/{id}',
        request: { params: z.object({ id: idSchema }) },
        responses: { 200: json(taskSchema), ...readErrors },
      }),
      (c) => {
        const task = readState(db).tasks.find(
          (t) => t.id === c.req.valid('param').id,
        );
        if (!task) fail('not_found', 'Задача не найдена.');
        return c.json(task, 200);
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/projects',
        responses: {
          200: json(z.object({ projects: z.array(projectSchema) })),
          ...readErrors,
        },
      }),
      (c) => c.json({ projects: readState(db).projects }, 200),
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/tasks/{id}/comments',
        request: { params: z.object({ id: idSchema }), query: pageQuery },
        responses: { 200: json(pageSchema(commentSchema)), ...readErrors },
      }),
      (c) => {
        const id = c.req.valid('param').id;
        const state = readState(db);
        if (!state.tasks.some((t) => t.id === id))
          fail('not_found', 'Задача не найдена.');
        return c.json(
          page(
            state.comments
              .filter((x) => x.taskId === id)
              .sort(
                (a, b) =>
                  a.createdAt.localeCompare(b.createdAt) ||
                  a.id.localeCompare(b.id),
              ),
            c.req.valid('query'),
            `comments:${id}`,
          ),
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/tasks/{id}/history',
        request: { params: z.object({ id: idSchema }), query: pageQuery },
        responses: { 200: json(pageSchema(eventSchema)), ...readErrors },
      }),
      (c) => {
        const id = c.req.valid('param').id;
        if (
          !db.orm
            .select({ id: tables.tasks.id })
            .from(tables.tasks)
            .where(eq(tables.tasks.id, id))
            .get()
        )
          fail('not_found', 'Задача не найдена.');
        return c.json(
          page(
            readEvents(db).filter(
              (e) => e.entityKind === 'task' && e.entityId === id,
            ),
            c.req.valid('query'),
            `history:${id}`,
          ),
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/operations',
        request: {
          query: pageQuery.extend({
            actor: z.string().optional(),
            since: z.coerce.number().int().min(0).optional(),
            until: z.coerce.number().int().min(0).optional(),
          }),
        },
        responses: {
          200: json(pageSchema(operationSummarySchema)),
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
              (q.since === undefined || (o.lastSeq ?? 0) > q.since) &&
              (q.until === undefined || (o.lastSeq ?? 0) <= q.until),
          )
          .reverse()
          .map(({ result: _result, commandHash: _hash, ...o }) => o);
        return c.json(
          page(rows, q, `operations:${JSON.stringify(identity)}`),
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/operations/{id}',
        request: { params: z.object({ id: idSchema }) },
        responses: { 200: json(storedOperationSchema), ...readErrors },
      }),
      (c) => {
        const o = readOperations(db).find(
          (o) => o.id === c.req.valid('param').id,
        );
        if (!o) fail('not_found', 'Операция пока неизвестна серверу.');
        const { commandHash: _hash, ...record } = o;
        return c.json(record, 200);
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/export',
        responses: { 200: json(exportSchema), ...readErrors },
      }),
      (c) => c.json(exportWorkspace(db), 200),
    );
  const streamApi = api.openapi(
    createRoute({
      method: 'get',
      path: '/api/events/stream',
      request: {
        query: z.object({
          generation: idSchema.optional(),
          since: z.coerce.number().int().nonnegative().optional(),
        }),
        headers: z.object({ 'last-event-id': z.string().optional() }),
      },
      responses: {
        200: {
          description:
            'SSE: события с generation:seq, границами операции, event reset и уведомление operations без изменения курсора',
          content: { 'text/event-stream': { schema: z.string() } },
        },
        ...readErrors,
      },
    }),
    (c) => {
      const last = c.req.header('last-event-id');
      const split = last?.lastIndexOf(':') ?? -1;
      const gen =
        last && split > 0 ? last.slice(0, split) : c.req.query('generation');
      const since = Number(
        last && split > 0 ? last.slice(split + 1) : (c.req.query('since') ?? 0),
      );
      if (!Number.isSafeInteger(since) || since < 0)
        fail('invalid', 'Неверный курсор событий.');
      const auth = c.get('auth');
      const encoder = new TextEncoder();
      let cleanup = () => {};
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (gen !== generation(db)) {
            controller.enqueue(
              encoder.encode(
                `event: reset\ndata: ${JSON.stringify({ generation: generation(db) })}\n\n`,
              ),
            );
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(': connected\n\n'));
          let closed = false;
          let unsubscribe = () => {};
          const close = () => {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            unsubscribe();
            try {
              controller.close();
            } catch {
              /* already cancelled */
            }
          };
          const write = (chunk: string) => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(chunk));
              if ((controller.desiredSize ?? 0) < -1000) close();
            } catch {
              close();
            }
          };
          // Every message (catch-up, events, operations hint) goes through the
          // hub, which re-checks access right before delivery. Revocation
          // reaches an idle stream on the next heartbeat at the latest.
          const subscriber: Subscriber = {
            actor: auth.actor,
            credential: auth.credential,
            check: auth.check,
            onEvents: (events) => {
              for (const e of events)
                write(
                  `id: ${e.generation}:${e.seq}\ndata: ${JSON.stringify(e)}\n\n`,
                );
            },
            onOperations: () =>
              // This is an invalidation hint, not a domain event. Do not emit
              // an SSE id: reconnect must keep the last domain-event cursor.
              write(
                `event: operations\ndata: ${JSON.stringify({ generation: generation(db) })}\n\n`,
              ),
            close: (reason) => {
              if (reason === 'revoked') write('event: revoked\ndata: {}\n\n');
              close();
            },
          };
          const timer = setInterval(() => {
            void (async () => {
              let allowed = false;
              try {
                allowed = await auth.check();
              } catch {
                allowed = false;
              }
              if (closed) return;
              if (!allowed) {
                hub.closeFor((s) => s === subscriber);
                subscriber.close('revoked');
                return;
              }
              write(': heartbeat\n\n');
            })();
          }, heartbeatMs);
          timer.unref();
          unsubscribe = hub.subscribe(subscriber);
          cleanup = close;
          hub.publishTo(subscriber, readEvents(db, since));
        },
        cancel() {
          cleanup();
        },
      });
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        },
      });
    },
  );
  const contextApi = streamApi.openapi(
    createRoute({
      method: 'get',
      path: '/api/context',
      responses: { 200: json(contextSchema), ...readErrors },
    }),
    (c) => {
      const state = readState(db);
      const today = todayInTimezone(timezone(), now());
      return c.json(
        {
          formatVersion: FORMAT_VERSION,
          generation: generation(db),
          seq: latestSeq(db),
          today,
          timezone: timezone(),
          areas: [...AREAS],
          statuses: [...STATUSES],
          projects: state.projects,
          originSystems: [
            ...new Set(
              state.tasks.flatMap((t) =>
                t.originSystem ? [t.originSystem] : [],
              ),
            ),
          ],
          fields: z.toJSONSchema(taskSchema),
          commands: Object.entries(commandPayloadSchemas).map(
            ([command, s]) => ({ command, payload: z.toJSONSchema(s) }),
          ),
          rules: [
            'Проект выбирается по описанию; при сомнении оставьте без проекта.',
            'Сначала поиск по origin, затем по тексту, затем создание.',
            'sync требует упорядоченную версию самого источника; время наблюдения и ETag её не заменяют.',
            'После conflict перечитайте current и оцените смысл поручения; повторяйте неизвестный исход только с прежним operationId.',
            'Undo сохраняет наибольшую обработанную версию источника и ручные решения.',
            'Календарные даты считаются в часовом поясе пространства.',
            'Focus: выбранное, новое от агентов, срок, дата возврата; каждая задача один раз.',
          ],
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
        },
        200,
      );
    },
  );
  const digestApi = contextApi.openapi(
    createRoute({
      method: 'get',
      path: '/api/digest',
      request: {
        query: z.object({
          since: z.coerce.number().int().nonnegative().optional(),
          generation: idSchema.optional(),
        }),
      },
      responses: { 200: json(digestSchema), ...readErrors },
    }),
    (c) => {
      const since = Number(c.req.query('since') ?? 0);
      if (!Number.isSafeInteger(since) || since < 0)
        fail('invalid', 'Неверный курсор.');
      checkGeneration(c.req.query('generation'));
      return c.json(
        db.sqlite.transaction(() => {
          const state = readState(db);
          const seq = latestSeq(db);
          const gen = generation(db);
          const today = todayInTimezone(timezone(), now());
          const groups = focusGroups(state.tasks, today);
          const ops = readOperations(db)
            .filter((o) => (o.lastSeq ?? 0) > since && (o.lastSeq ?? 0) <= seq)
            .reverse()
            .map(({ result: _result, commandHash: _hash, ...o }) => o);
          const operationPage = page<OperationSummary>(
            ops,
            { limit: 50 },
            `operations:${JSON.stringify({ since, until: seq })}`,
          );
          const limitPart = <T extends Entity>(
            items: T[],
            href: string,
            identity: string,
          ) => ({ ...page(items, { limit: 50 }, identity), href });
          return {
            generation: gen,
            seq,
            today,
            timezone: timezone(),
            focus: groups.map((g) => ({
              ...g,
              tasks: g.tasks.slice(0, 50),
              more: g.tasks.length > 50,
              nextCursor: page(g.tasks, { limit: 50 }, `focus:${g.id}`)
                .nextCursor,
              href: `/api/focus?group=${g.id}&generation=${gen}`,
            })),
            waiting: limitPart(
              queryTasks(state.tasks, state.projects, {
                status: 'waiting',
                hasFollowUp: true,
              }),
              `/api/tasks?status=waiting&hasFollowUp=true&generation=${gen}`,
              `tasks:${JSON.stringify({ status: 'waiting', hasFollowUp: 'true' })}`,
            ),
            counts: {
              tasks: state.tasks.length,
              archived: state.tasks.filter((t) => t.archived).length,
              projects: state.projects.length,
            },
            operations: {
              ...operationPage,
              href: `/api/operations?since=${since}&until=${seq}&generation=${gen}`,
            },
          };
        })(),
        200,
      );
    },
  );
  const completeApi = digestApi.openapi(
    createRoute({
      method: 'get',
      path: '/api/focus',
      request: {
        query: pageQuery.extend({
          group: z.enum(['selected', 'new', 'due', 'follow-ups']).optional(),
        }),
      },
      responses: {
        200: json(
          z.union([
            pageSchema(taskSchema),
            z.object({
              generation: idSchema,
              seq: z.number(),
              groups: z.array(focusGroupSchema),
            }),
          ]),
        ),
        ...readErrors,
      },
    }),
    (c) => {
      checkGeneration(c.req.query('generation'));
      const group = c.req.query('group');
      const groups = focusGroups(
        readState(db).tasks,
        todayInTimezone(timezone(), now()),
      );
      if (group) {
        const selected = groups.find((g) => g.id === group);
        if (!selected) fail('invalid', 'Неизвестная группа Focus.');
        const q = pageQuery.parse(
          Object.fromEntries(new URL(c.req.url).searchParams),
        );
        return c.json(page(selected.tasks, q, `focus:${group}`), 200);
      }
      return c.json(
        { generation: generation(db), seq: latestSeq(db), groups },
        200,
      );
    },
  );
  completeApi.doc('/api/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'TaskIndex',
      version: '2.0.0',
      description:
        'Задачи, проекты, комментарии и безопасные команды владельца и агентов',
    },
    servers: [{ url: baseURL }],
  });
  return Object.assign(completeApi, { closeStreams: () => hub.closeAll() });
}
export type AppType = ReturnType<typeof createApp>;
