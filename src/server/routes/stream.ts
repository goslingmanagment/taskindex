import { createRoute } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { fail } from '../../shared/errors.js';
import {
  generation,
  latestOperationSeq,
  latestSeq,
  readEvents,
} from '../db.js';
import { replayBacklog } from '../sse.js';
import type { Subscriber } from '../sse.js';
import { generationQuery, readErrors } from '../http/openapi.js';
import type { Deps, Env } from '../http/deps.js';

export const registerStreamRoutes = <T extends OpenAPIHono<Env>>(
  app: T,
  deps: Deps,
) => {
  const { db, hub, heartbeatMs, backlogLimit } = deps;
  return app.openapi(
    createRoute({
      method: 'get',
      path: '/api/events/stream',
      operationId: 'streamEvents',
      summary: 'Поток событий (SSE)',
      description:
        'id сообщения — generation:seq; event: reset означает «возьмите снимок»: другое поколение или курсор дальше sseBacklogLimit (5 000 событий) от конца журнала; хвост короче отдаётся порциями по 500; event: operations (с operationSeq) как подсказка без сдвига курсора, event: revoked при отзыве ключа.',
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
          // Another generation or a cursor too far behind: the client takes
          // a snapshot instead of a tail (plan 01, step 10).
          if (gen !== generation(db) || latestSeq(db) - since > backlogLimit) {
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
          // Between portions the event loop runs; a full queue waits for the
          // consumer instead of growing.
          const open = () => !closed;
          const ready = async () => {
            do await new Promise<void>((resolve) => setImmediate(resolve));
            while (open() && (controller.desiredSize ?? 0) < 0);
            return open();
          };
          void replayBacklog(
            hub,
            subscriber,
            since,
            (from, limit) => readEvents(db, from, limit),
            ready,
          );
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
};
