import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { createAuth } from './auth.js';
import { ConfigError, loadServerConfig } from './config.js';
import { createLogger } from './log.js';
import { DomainError } from '../shared/errors.js';
let config;
try {
  config = loadServerConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
const logger = createLogger(config.logLevel);
const { baseURL, port } = config;
const db = openDatabase(config.databasePath);
const trustedOrigins = config.production
  ? [baseURL]
  : [baseURL, 'http://localhost:5173'];
const auth = createAuth(db, { baseURL, secret: config.secret, trustedOrigins });
const app = createApp({
  db,
  auth,
  baseURL,
  trustedOrigins,
  build: config.build,
  writes: config.writes,
  deploymentId: config.deploymentId,
  migrationsDir: config.migrationsDir,
  logger,
});
app.all('/api/*', (c) =>
  c.json(new DomainError('not_found', 'Метод API не найден.').toJSON(), 404),
);
app.use('*', serveStatic({ root: './dist/web' }));
app.get('*', serveStatic({ path: './dist/web/index.html' }));
const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });
logger.info({
  event: 'listening',
  host: '0.0.0.0',
  port,
  build: config.build,
  writes: config.writes,
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  app.closeStreams();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => {
    if ('closeAllConnections' in server) server.closeAllConnections();
    db.close();
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
