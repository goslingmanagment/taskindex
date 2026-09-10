import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { OperationIssue } from '../../shared/model.js';
import {
  DomainError,
  errorBody,
  formatIssuePath,
} from '../../shared/errors.js';
import { errorFields } from '../log.js';
import type { Logger } from '../log.js';
import type { Env } from './deps.js';

const unavailableCodes = [
  'SQLITE_BUSY',
  'SQLITE_READONLY',
  'SQLITE_IOERR',
  'SQLITE_FULL',
  'SQLITE_CANTOPEN',
];

export const sqliteUnavailable = (error: unknown) => {
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

type HonoInit = NonNullable<ConstructorParameters<typeof OpenAPIHono<Env>>[0]>;
// Route input that failed its schema: one 400 with issues by field.
export const defaultHook: HonoInit['defaultHook'] = (result, c) => {
  if (result.success) return;
  return c.json(
    new DomainError('invalid', 'Проверьте параметры запроса.', {
      issues: issuesOf(
        result.error,
        result.target === 'json' ? '' : result.target,
      ),
    }).toJSON(),
    400,
  );
};

export const bodyLimitError = (message: string) => (c: Context) =>
  c.json(new DomainError('invalid', message).toJSON(), 400);

// Errors reaching this boundary were thrown before or inside
// executeOperation, so the transaction rolled back and the outcome is known:
// `internal` is final (retryable: false). Only SQLite availability errors stay
// retryable.
export function registerErrorHandler(
  app: OpenAPIHono<Env>,
  logger: Logger,
): void {
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
}
