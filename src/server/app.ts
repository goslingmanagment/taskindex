import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { DomainError } from '../shared/errors.js';
import { assertSchema, getSetting, schemaVersion, withWrite } from './db.js';
import { writesAreOpen } from './admin.js';
import { createEventHub, SSE_BACKLOG_LIMIT, SSE_HEARTBEAT_MS } from './sse.js';
import { createLogger } from './log.js';
import type { AppOptions, Deps, Env } from './http/deps.js';
import {
  bodyLimitError,
  defaultHook,
  registerErrorHandler,
} from './http/errors.js';
import { createAuthMiddleware } from './http/auth-middleware.js';
import { createRequestLog } from './http/request-log.js';
import { createPagination } from './http/pagination.js';
import { createProjection } from './projection.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerCommandRoutes } from './routes/commands.js';
import { registerReadRoutes } from './routes/reads.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerOperationRoutes } from './routes/operations.js';
import { registerStreamRoutes } from './routes/stream.js';
import { registerContextRoutes } from './routes/context.js';
import { registerDigestRoutes } from './routes/digest.js';
import { registerFocusRoutes } from './routes/focus.js';
import { describeApi } from './http/document.js';

export type { AppOptions };

// Same headers in dev, e2e and production; HSTS belongs to the TLS terminator
// (nginx), which alone knows the connection is encrypted. CSP starts
// report-only: enforce only after e2e shows zero violations.
const headers = secureHeaders({
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
});

// Assembly only: dependencies, middleware in the order they must run, the
// chain of route modules and the OpenAPI document. Every behaviour lives in
// `http/*`, `routes/*`, `context.ts`, `digest.ts` and `sse.ts` (plan 06).
export function createApp(options: AppOptions) {
  const { db } = options;
  assertSchema(db, options.migrationsDir);
  // Zod messages in `issues` follow the language of the rest of the contract.
  z.config(z.locales.ru());
  withWrite(db, () =>
    db.sqlite
      .prepare("UPDATE settings SET value=value WHERE key='generation'")
      .run(),
  );
  const baseURL = options.baseURL ?? 'http://localhost:3001';
  const logger = options.logger ?? createLogger('info');
  const hub = options.hub ?? createEventHub();
  const paging = createPagination(db);
  const deps: Deps = {
    db,
    options,
    logger,
    hub,
    version: schemaVersion(options.migrationsDir),
    heartbeatMs: options.sseHeartbeatMs ?? SSE_HEARTBEAT_MS,
    backlogLimit: options.sseBacklogLimit ?? SSE_BACKLOG_LIMIT,
    origins: options.trustedOrigins ?? [baseURL, 'http://localhost:5173'],
    now: () => options.now?.() ?? new Date().toISOString(),
    timezone: () => getSetting(db, 'timezone') ?? 'Europe/Moscow',
    opened: () =>
      writesAreOpen(db, options.writes ?? 'open', options.deploymentId),
    checkGeneration: paging.checkGeneration,
    paging,
    projection: createProjection(db, options.projectionCache !== false),
  };

  const app = new OpenAPIHono<Env>({ defaultHook });
  registerErrorHandler(app, logger);
  app.use('*', headers);
  app.use('/api/*', createRequestLog(logger));
  app.use('/api/*', createAuthMiddleware(deps));
  app.use(
    '/api/commands',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: bodyLimitError('Слишком большой запрос.'),
    }),
  );
  app.use(
    '/api/commands/batch',
    bodyLimit({
      maxSize: 4 * 1024 * 1024,
      onError: bodyLimitError('Слишком большой пакет.'),
    }),
  );
  app.on(
    ['GET', 'POST'],
    '/api/auth/*',
    async (c): Promise<Response> =>
      options.auth
        ? options.auth.handler(c.req.raw)
        : c.json(
            new DomainError(
              'unauthorized',
              'Авторизация не настроена.',
            ).toJSON(),
            401,
          ),
  );

  const withHealth = registerHealthRoutes(app, deps);
  const withCommands = registerCommandRoutes(withHealth, deps);
  const withReads = registerReadRoutes(withCommands, deps);
  const withHistory = registerHistoryRoutes(withReads, deps);
  const withOperations = registerOperationRoutes(withHistory, deps);
  const withStream = registerStreamRoutes(withOperations, deps);
  const withContext = registerContextRoutes(withStream, deps);
  const withDigest = registerDigestRoutes(withContext, deps);
  const api = registerFocusRoutes(withDigest, deps);

  describeApi(api, baseURL);
  return Object.assign(api, { closeStreams: () => hub.closeAll() });
}
export type AppType = ReturnType<typeof createApp>;
