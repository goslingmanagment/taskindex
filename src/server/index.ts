import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { serveWeb } from './static.js';
import { checkGenerationSidecar, openDatabase } from './db.js';
import { createAuth } from './auth.js';
import { ConfigError, loadServerConfig, webDirectory } from './config.js';
import { createLogger } from './log.js';
import { errorBody } from '../shared/errors.js';
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
checkGenerationSidecar(db, logger);
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
  c.json(errorBody('not_found', 'Метод API не найден.'), 404),
);
serveWeb(app, webDirectory(config.webDir));
const server = serve({ fetch: app.fetch, port, hostname: config.host });
logger.info({
  event: 'listening',
  host: config.host,
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
