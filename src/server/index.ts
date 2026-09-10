import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { createAuth } from './auth.js';
const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? (production ? '3000' : '3001'));
const baseURL = process.env.BASE_URL ?? `http://localhost:${port}`;
const secret = process.env.BETTER_AUTH_SECRET;
if (!secret)
  throw new Error('BETTER_AUTH_SECRET должен быть передан через окружение.');
const db = openDatabase(process.env.DATABASE_PATH ?? './data/dev.db');
const trustedOrigins = production
  ? [baseURL]
  : [baseURL, 'http://localhost:5173'];
const auth = createAuth(db, { baseURL, secret, trustedOrigins });
const app = createApp({
  db,
  auth,
  baseURL,
  trustedOrigins,
  build: process.env.BUILD ?? process.env.BUILD_ID ?? 'development',
  writes: process.env.TASKINDEX_WRITES === 'held' ? 'held' : 'open',
  deploymentId: process.env.TASKINDEX_DEPLOYMENT,
});
app.all('/api/*', (c) =>
  c.json(
    {
      ok: false,
      code: 'not_found',
      message: 'Метод API не найден.',
      retryable: false,
    },
    404,
  ),
);
app.use('*', serveStatic({ root: './dist/web' }));
app.get('*', serveStatic({ path: './dist/web/index.html' }));
const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });
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
