import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { eq } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { AREAS, STATUSES, FORMAT_VERSION } from '../shared/model.js';
import type {
  Actor,
  Entity,
  OperationIssue,
  Page,
  OperationSummary,
} from '../shared/model.js';
import {
  idSchema,
  areaSchema,
  statusSchema,
  commandEnvelopeSchema,
  batchEnvelopeSchema,
  commandPayloadSchemas,
  commandNames,
} from '../shared/schemas.js';
import {
  taskSchema,
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
  meSchema,
  healthSchema,
  contextSchema,
  digestSchema,
  focusResponseSchema,
  projectsResponseSchema,
} from '../shared/domain-schemas.js';
import {
  DomainError,
  errorBody,
  fail,
  formatIssuePath,
} from '../shared/errors.js';
import { LIMITS } from '../shared/limits.js';
import { focusGroups, queryTasks, todayInTimezone } from '../shared/queries.js';
import type { DatabaseHandle } from './db.js';
import {
  assertSchema,
  generation,
  getSetting,
  latestOperationSeq,
  latestSeq,
  readState,
  readEvents,
  readOperations,
  schemaVersion,
} from './db.js';
import * as tables from './schema.js';
import type { Auth, Authorized } from './auth.js';
import { authorizeRequest, staticAuthorization } from './auth.js';
import { exportWorkspace, listAgents, writesAreOpen } from './admin.js';
import { executeOperation } from './operations.js';
import { createEventHub, SSE_HEARTBEAT_MS } from './sse.js';
import type { EventHub, Subscriber } from './sse.js';
import { createLogger, errorFields } from './log.js';
import type { Logger } from './log.js';
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
  logger?: Logger;
  hub?: EventHub;
  now?: () => string;
  ids?: () => string;
};
type Env = {
  Variables: {
    actor: Actor;
    auth: Authorized;
    requestId: string;
    operationId?: string;
    commandName?: string;
  };
};
// Clients may supply their own correlation id; anything else gets a fresh one
// so arbitrary strings never reach the log.
const requestIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const unavailableCodes = [
  'SQLITE_BUSY',
  'SQLITE_READONLY',
  'SQLITE_IOERR',
  'SQLITE_FULL',
  'SQLITE_CANTOPEN',
];
const sqliteUnavailable = (error: unknown) => {
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === 'string' && unavailableCodes.some((c) => code.startsWith(c))
  );
};
// Zod issues as the API reports them: `payload.title`, `commands[1].payload`,
// `query.limit`. The body of a command has no prefix (its fields are the
// envelope), every other validation target is prefixed with its name.
const issuesOf = (error: z.ZodError, prefix = ''): OperationIssue[] =>
  error.issues.map((issue) => {
    const path = formatIssuePath(issue.path);
    return {
      path: prefix ? (path ? `${prefix}.${path}` : prefix) : path,
      message: issue.message,
    };
  });
// `.meta({ id })` makes z.toJSONSchema return `{ $ref, $defs }`; /api/context
// promises an inline object for `fields`, so the root definition is unwrapped.
function inlineJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $ref, $defs, ...rest } = z.toJSONSchema(schema) as {
    $ref?: string;
    $defs?: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
  };
  if (!$ref || !$defs) return { ...rest, ...($defs ? { $defs } : {}) };
  const id = $ref.replace('#/$defs/', '');
  const { [id]: root, ...others } = $defs;
  return {
    ...rest,
    ...root,
    ...(Object.keys(others).length ? { $defs: others } : {}),
  };
}
const json = <T extends z.ZodType>(
  schema: T,
  description = 'Ответ приложения',
) => ({ description, content: { 'application/json': { schema } } });
const generationQuery = idSchema
  .optional()
  .describe('Поколение базы; при несовпадении 409 generation_changed');
const pageQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIMITS.pageSize)
    .default(100)
    .describe(`Размер страницы 1-${LIMITS.pageSize}`),
  cursor: z
    .string()
    .optional()
    .describe('Курсор из nextCursor предыдущей страницы того же запроса'),
  generation: generationQuery,
});
const flag = (description: string) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .describe(`${description}: true/false или 1/0`);
const truthy = (value?: string) => value === 'true' || value === '1';
const idParam = z.object({
  id: idSchema.describe('Идентификатор записи'),
});
const readErrors = {
  400: json(operationErrorSchema, 'Неверные параметры: issues по полям'),
  401: json(operationErrorSchema, 'Нет сессии владельца или ключа агента'),
  403: json(operationErrorSchema, 'Недостаточно прав или недопустимый Origin'),
  404: json(operationErrorSchema, 'Запись не найдена'),
  409: json(
    operationErrorSchema,
    'Конфликт: generation_changed, conflict, operation_mismatch, not_undoable',
  ),
  503: json(operationErrorSchema, 'База недоступна или запись закрыта'),
};
const cursorSchema = z.object({
  generation: idSchema,
  seq: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  query: z.string(),
  fingerprint: z.string(),
});
const stripStored = <T extends { result: unknown; commandHash: string }>({
  result: _result,
  commandHash: _hash,
  ...summary
}: T) => summary;
export function createApp(options: AppOptions) {
  const { db } = options;
  assertSchema(db, options.migrationsDir);
  const version = schemaVersion(options.migrationsDir);
  // Zod messages in `issues` follow the language of the rest of the contract.
  z.config(z.locales.ru());
  db.sqlite
    .prepare("UPDATE settings SET value=value WHERE key='generation'")
    .run();
  const baseURL = options.baseURL ?? 'http://localhost:3001';
  const origins = options.trustedOrigins ?? [baseURL, 'http://localhost:5173'];
  const hub = options.hub ?? createEventHub();
  const logger = options.logger ?? createLogger('info');
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
      if (result.success) return;
      return c.json(
        errorBody('invalid', 'Проверьте параметры запроса.', {
          issues: issuesOf(
            result.error,
            result.target === 'json' ? '' : result.target,
          ),
        }),
        400,
      );
    },
  });
  // Errors reaching this boundary were thrown before or inside
  // executeOperation, so the transaction rolled back and the outcome is
  // known: `internal` is final (retryable: false). Only SQLite availability
  // errors stay retryable.
  app.onError((error, c) => {
    const domain =
      error instanceof DomainError
        ? error
        : error instanceof z.ZodError
          ? new DomainError('invalid', 'Проверьте поля запроса.', {
              issues: issuesOf(error),
            })
          : sqliteUnavailable(error)
            ? new DomainError('unavailable', 'База временно недоступна.')
            : undefined;
    if (domain)
      return c.json(domain.toJSON(), domain.status as ContentfulStatusCode);
    logger.error({
      event: 'internal_error',
      requestId: c.get('requestId'),
      method: c.req.method,
      path: c.req.path,
      actor: c.get('actor')?.id,
      operationId: c.get('operationId'),
      command: c.get('commandName'),
      ...errorFields(error),
    });
    return c.json(
      errorBody(
        'internal',
        'Внутренняя ошибка сервера. Операция не выполнена.',
      ),
      500,
    );
  });
  // Same headers in dev, e2e and production; HSTS belongs to the TLS
  // terminator (nginx), which alone knows the connection is encrypted.
  // CSP starts report-only: enforce only after e2e shows zero violations.
  app.use(
    '*',
    secureHeaders({
      strictTransportSecurity: false,
      xFrameOptions: 'DENY',
      contentSecurityPolicyReportOnly: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
      },
    }),
  );
  app.use('/api/*', async (c, next) => {
    const started = Date.now();
    const given = c.req.header('x-request-id');
    const requestId =
      given && requestIdPattern.test(given) ? given : randomUUID();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
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
      // /api/openapi.json is served with the same key as every other read:
      // the owner chose not to publish the contract without a key.
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
      rejectedStatus =
        error instanceof DomainError
          ? error.status
          : sqliteUnavailable(error)
            ? 503
            : 500;
      throw error;
    } finally {
      // Rejections are warnings, commands are info, everything else is debug:
      // LOG_LEVEL=debug shows every /api/* request, warn only refusals.
      const code = rejectedStatus ?? c.res.status;
      const entry = {
        event: 'request',
        requestId,
        method: c.req.method,
        path: c.req.path,
        operationId: c.get('operationId'),
        command: c.get('commandName'),
        actor: c.get('actor')?.id,
        code,
        durationMs: Date.now() - started,
      };
      if (code >= 400) logger.warn(entry);
      else if (c.req.path.startsWith('/api/commands')) logger.info(entry);
      else logger.debug(entry);
    }
  });
  const tooLarge = (message: string) => (c: Context) =>
    c.json(errorBody('invalid', message), 400);
  app.use(
    '/api/commands',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: tooLarge('Слишком большой запрос.'),
    }),
  );
  app.use(
    '/api/commands/batch',
    bodyLimit({
      maxSize: 4 * 1024 * 1024,
      onError: tooLarge('Слишком большой пакет.'),
    }),
  );
  app.on(
    ['GET', 'POST'],
    '/api/auth/*',
    async (c): Promise<Response> =>
      options.auth
        ? options.auth.handler(c.req.raw)
        : c.json(errorBody('unauthorized', 'Авторизация не настроена.'), 401),
  );
  // executeOperation commits inside itself. Anything that fails afterwards
  // (fan-out, serialisation) must not change the answer: the outcome is
  // already durable, so it is logged and the stored result is returned.
  const runOperation = (
    c: Context<Env>,
    input: Parameters<typeof executeOperation>[1],
    commandName: string,
  ) => {
    c.set('operationId', input.operationId);
    c.set('commandName', commandName);
    const result = executeOperation(db, input, c.get('actor'), {
      now: now(),
      ids: options.ids,
    });
    try {
      hub.publish(result.freshEvents);
      if (result.freshOperation) hub.notifyOperations();
    } catch (error) {
      logger.error({
        event: 'post_commit_error',
        requestId: c.get('requestId'),
        operationId: input.operationId,
        command: commandName,
        actor: c.get('actor').id,
        ...errorFields(error),
      });
    }
    return c.json(result.body, result.status as 200);
  };
  const api = app
    .openapi(
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
    )
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
          { ...c.get('actor'), generation: generation(db), seq: latestSeq(db) },
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
          db.sqlite.transaction(() => {
            const state = readState(db);
            return {
              generation: generation(db),
              seq: latestSeq(db),
              schemaVersion: version,
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
        operationId: 'postCommand',
        summary: 'Выполнить одну команду',
        description:
          'Идемпотентно по operationId: повтор того же конверта возвращает сохранённый результат, другой конверт с тем же id — 409 operation_mismatch. Отказ после принятия конверта тоже сохраняется.',
        tags: ['commands'],
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
        return runOperation(c, input, input.command);
      },
    )
    .openapi(
      createRoute({
        method: 'post',
        path: '/api/commands/batch',
        operationId: 'postBatch',
        summary: 'Выполнить атомарный пакет команд',
        description:
          'Все команды или ни одной; при отказе commandIndex указывает на первую отклонённую команду.',
        tags: ['commands'],
        request: {
          body: {
            required: true,
            content: { 'application/json': { schema: batchEnvelopeSchema } },
          },
        },
        responses: { 200: json(operationResponseSchema), ...readErrors },
      }),
      (c) => runOperation(c, c.req.valid('json'), 'batch'),
    )
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
        operationId: 'getTask',
        summary: 'Задача по идентификатору',
        tags: ['tasks'],
        request: { params: idParam },
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
        operationId: 'listProjects',
        summary: 'Все проекты',
        tags: ['projects'],
        responses: { 200: json(projectsResponseSchema), ...readErrors },
      }),
      (c) => c.json({ projects: readState(db).projects }, 200),
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
        operationId: 'getExport',
        summary: 'Полный экспорт пространства',
        description:
          'Записи, журнал событий и операций с operationSeq; формат formatVersion принимает taskindex-admin import.',
        tags: ['context'],
        responses: { 200: json(exportSchema), ...readErrors },
      }),
      (c) => c.json(exportWorkspace(db), 200),
    );
  const streamApi = api.openapi(
    createRoute({
      method: 'get',
      path: '/api/events/stream',
      operationId: 'streamEvents',
      summary: 'Поток событий (SSE)',
      description:
        'id сообщения — generation:seq; event: reset при другом поколении, event: operations (с operationSeq) как подсказка без сдвига курсора, event: revoked при отзыве ключа.',
      tags: ['events'],
      request: {
        query: z.object({
          generation: generationQuery,
          since: z.coerce
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('Последнее известное событие; заменяется Last-Event-ID'),
        }),
        headers: z.object({
          'last-event-id': z
            .string()
            .optional()
            .describe('Курсор переподключения generation:seq'),
        }),
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
                `event: operations\ndata: ${JSON.stringify({ generation: generation(db), operationSeq: latestOperationSeq(db) })}\n\n`,
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
          'x-request-id': c.get('requestId'),
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
      operationId: 'getContext',
      summary: 'Справочник для агента',
      description:
        'Актор запроса, агенты, области, статусы, проекты, JSON Schema полей задачи и параметров команд, правила и счётчики.',
      tags: ['context'],
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
          me: c.get('actor'),
          agents: listAgents(db),
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
          fields: inlineJsonSchema(taskSchema),
          commands: commandNames.map((command) => ({
            command,
            payload: z.toJSONSchema(commandPayloadSchemas[command]),
          })),
          rules: [
            'Проект выбирается по описанию; при сомнении оставьте без проекта.',
            'Сначала поиск по origin, затем по тексту, затем создание.',
            'sync требует упорядоченную версию самого источника; время наблюдения и ETag её не заменяют.',
            'После conflict перечитайте current и оцените смысл поручения; повторяйте неизвестный исход только с прежним operationId.',
            'Undo: владелец отменяет любые операции; агент не отменяет операции с событиями владельца (403), операции других агентов отменяет в рамках scope, чужой комментарий — нет. Ошибку владельца не исправляйте отменой: сообщите комментарием.',
            'Undo не трогает версию источника и список ownerFields.',
            'focus ставит и снимает только владелец: прямая команда агента с focus получает 403, в sync поле пропускается (skipped: owner).',
            'Решения владельца (ownerFields, а также статус, архив, проект и область после его касания) sync не перезаписывает. Прямая команда агента, меняющая поле из ownerFields, требует в конверте confirmOwnerFields: true (иначе 403); флаг остаётся в результате операции как след поручения, доказательством он не является.',
            'После ручной правки владельца чеклист защищён целиком: источник его не обновляет, новые шаги добавляйте checklist.add по поручению с confirmOwnerFields.',
            'Календарные даты считаются в часовом поясе пространства.',
            'Focus: выбранное, новое от агентов, срок, дата возврата; каждая задача один раз.',
            'Журнал операций читайте по operationSeq (after= в /api/operations, sinceOp= в /api/digest): так видны отказы и операции без событий; since по событиям их не показывает.',
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
      const since = q.since ?? 0;
      checkGeneration(q.generation);
      return c.json(
        db.sqlite.transaction(() => {
          const state = readState(db);
          const seq = latestSeq(db);
          const operationSeq = latestOperationSeq(db);
          const gen = generation(db);
          const today = todayInTimezone(timezone(), now());
          const groups = focusGroups(state.tasks, today);
          const ops = readOperations(db)
            .filter(
              (o) =>
                (q.sinceOp === undefined || o.operationSeq > q.sinceOp) &&
                (!since || (o.lastSeq ?? 0) > since) &&
                (o.lastSeq ?? 0) <= seq,
            )
            .reverse()
            .map(stripStored);
          const operationPage = page<OperationSummary>(
            ops,
            { limit: LIMITS.digestPage },
            `operations:${JSON.stringify({ since, sinceOp: q.sinceOp ?? null, until: seq })}`,
          );
          const titles = new Map(state.tasks.map((t) => [t.id, t.title]));
          const byId = new Map(state.comments.map((x) => [x.id, x]));
          // Owner comments in event order: the agent reads them forward and
          // continues with since = seq of the last one shown.
          const comments = readEvents(db, since).flatMap((e) => {
            const comment =
              e.entityKind === 'comment' &&
              e.command === 'comment.add' &&
              !e.actorId.startsWith('agent:')
                ? byId.get(e.entityId)
                : undefined;
            return comment && !comment.deletedAt
              ? [
                  {
                    ...comment,
                    taskTitle: titles.get(comment.taskId) ?? '',
                    seq: e.seq,
                  },
                ]
              : [];
          });
          const limitPart = <T extends Entity>(
            items: T[],
            href: string,
            identity: string,
          ) => ({
            ...page(items, { limit: LIMITS.digestPage }, identity),
            href,
          });
          return {
            generation: gen,
            seq,
            operationSeq,
            today,
            timezone: timezone(),
            focus: groups.map((g) => ({
              ...g,
              tasks: g.tasks.slice(0, LIMITS.digestPage),
              more: g.tasks.length > LIMITS.digestPage,
              nextCursor: page(
                g.tasks,
                { limit: LIMITS.digestPage },
                `focus:${g.id}`,
              ).nextCursor,
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
              href:
                q.sinceOp === undefined
                  ? `/api/operations?since=${since}&until=${seq}&generation=${gen}`
                  : `/api/operations?after=${q.sinceOp}&generation=${gen}`,
            },
            comments: {
              generation: gen,
              seq,
              items: comments.slice(0, LIMITS.digestPage),
              more: comments.length > LIMITS.digestPage,
              nextCursor: null,
              href: `/api/events?generation=${gen}&since=${since}`,
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
      operationId: 'getFocus',
      summary: 'Группы Focus',
      description:
        'Без group — все группы целиком; с group — страница одной группы.',
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
      const groups = focusGroups(
        readState(db).tasks,
        todayInTimezone(timezone(), now()),
      );
      if (q.group) {
        const selected = groups.find((g) => g.id === q.group);
        if (!selected) fail('invalid', 'Неизвестная группа Focus.');
        return c.json(page(selected.tasks, q, `focus:${q.group}`), 200);
      }
      return c.json(
        { generation: generation(db), seq: latestSeq(db), groups },
        200,
      );
    },
  );
  completeApi.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
    type: 'http',
    scheme: 'bearer',
    description: 'Ключ агента в Authorization: Bearer <ключ>',
  });
  completeApi.openAPIRegistry.registerComponent('securitySchemes', 'apiKey', {
    type: 'apiKey',
    in: 'header',
    name: 'x-api-key',
    description: 'Ключ агента в заголовке x-api-key',
  });
  completeApi.openAPIRegistry.registerComponent(
    'securitySchemes',
    'ownerSession',
    {
      type: 'apiKey',
      in: 'cookie',
      name: 'better-auth.session_token',
      description:
        'Сессия владельца после входа через /api/auth; записи требуют доверенный Origin',
    },
  );
  completeApi.doc('/api/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'TaskIndex',
      version: '2.0.0',
      description:
        'Задачи, проекты, комментарии и безопасные команды владельца и агентов. Документ отдаётся по тому же ключу, что и остальные чтения.',
    },
    servers: [{ url: baseURL }],
    security: [{ bearer: [] }, { apiKey: [] }, { ownerSession: [] }],
    tags: [
      { name: 'health', description: 'Состояние сервера' },
      { name: 'commands', description: 'Запись: команды и пакеты' },
      { name: 'tasks', description: 'Задачи, снимок и Focus' },
      { name: 'projects', description: 'Проекты' },
      { name: 'comments', description: 'Комментарии' },
      { name: 'operations', description: 'Журнал операций' },
      { name: 'events', description: 'События и поток' },
      { name: 'context', description: 'Справочник, сводка, экспорт' },
    ],
  });
  return Object.assign(completeApi, { closeStreams: () => hub.closeAll() });
}
export type AppType = ReturnType<typeof createApp>;
