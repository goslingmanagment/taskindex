import { createMiddleware } from 'hono/factory';
import { fail } from '../../shared/errors.js';
import { authorizeRequest, staticAuthorization } from '../auth.js';
import type { Deps, Env } from './deps.js';

const safeMethods = ['GET', 'HEAD', 'OPTIONS'];

// One gate for every /api/* request: who is asking, whether writes are open
// and whether the Origin of an owner write is trusted.
export const createAuthMiddleware = (deps: Deps) =>
  createMiddleware<Env>(async (c, next) => {
    const { db, options, origins, opened } = deps;
    if (c.req.path.startsWith('/api/auth/')) {
      // Agent keys are issued and revoked only by taskindex-admin; no HTTP
      // key management exists even if a plugin ever registers such routes.
      if (c.req.path.startsWith('/api/auth/api-key/'))
        fail(
          'not_found',
          'Ключи агентов выдаются только командой taskindex-admin.',
        );
      if (!opened() && !safeMethods.includes(c.req.method))
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
    if (!safeMethods.includes(c.req.method)) {
      if (
        actor.kind === 'owner' &&
        !origins.includes(c.req.header('origin') ?? '')
      )
        fail('forbidden', 'Недопустимый Origin.');
      if (!opened()) fail('unavailable', 'Запись закрыта на время обновления.');
    }
    await next();
  });
