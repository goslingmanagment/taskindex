import { createRoute } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
  batchEnvelopeSchema,
  commandEnvelopeSchema,
} from '../../shared/schemas.js';
import { operationResponseSchema } from '../../shared/domain-schemas.js';
import { executeOperation } from '../operations.js';
import { errorFields } from '../log.js';
import { json, readErrors } from '../http/openapi.js';
import type { Deps, Env } from '../http/deps.js';

// executeOperation commits inside itself. Anything that fails afterwards
// (fan-out, serialisation) must not change the answer: the outcome is
// already durable, so it is logged and the stored result is returned.
const runOperation = (
  deps: Deps,
  c: Context<Env>,
  input: Parameters<typeof executeOperation>[1],
  commandName: string,
) => {
  const { db, options, logger, hub, now, projection } = deps;
  c.set('operationId', input.operationId);
  c.set('commandName', commandName);
  const result = executeOperation(db, input, c.get('actor'), {
    now: now(),
    ids: options.ids,
    projection,
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

export const registerCommandRoutes = <T extends OpenAPIHono<Env>>(
  app: T,
  deps: Deps,
) =>
  app
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
        return runOperation(deps, c, input, input.command);
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
      (c) => runOperation(deps, c, c.req.valid('json'), 'batch'),
    );
