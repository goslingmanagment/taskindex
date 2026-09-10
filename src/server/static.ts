import { join } from 'node:path';
import type { Context, Env, Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
// Vite hashes everything under /assets, so those files never change under the
// same name; index.html and other unhashed files must be revalidated.
export const cacheControl = (path: string) =>
  /[/\\]assets[/\\]/.test(path)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
// onFound runs after serveStatic built its Response, so the header goes on
// c.res (merged into that Response by Hono), not through c.header().
const withCache = (path: string, c: Context) =>
  c.res.headers.set('Cache-Control', cacheControl(path));
// Serves the built client from `root` with an index.html fallback for deep links.
export function serveWeb<E extends Env>(app: Hono<E>, root: string) {
  app.use('*', serveStatic({ root, onFound: withCache }));
  app.get(
    '*',
    serveStatic({ path: join(root, 'index.html'), onFound: withCache }),
  );
  return app;
}
