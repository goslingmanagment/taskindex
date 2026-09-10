import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { DomainError } from '../../shared/errors.js';
import type { Logger } from '../log.js';
import type { Env } from './deps.js';
import { sqliteUnavailable } from './errors.js';

// Clients may supply their own correlation id; anything else gets a fresh one
// so arbitrary strings never reach the log.
const requestIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

// Rejections are warnings, commands are info, everything else is debug:
// LOG_LEVEL=debug shows every /api/* request, warn only refusals.
export const createRequestLog = (logger: Logger) =>
  createMiddleware<Env>(async (c, next) => {
    const started = Date.now();
    const given = c.req.header('x-request-id');
    const requestId =
      given && requestIdPattern.test(given) ? given : randomUUID();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    let rejectedStatus: number | undefined;
    try {
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
