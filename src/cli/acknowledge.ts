import {
  operationErrorSchema,
  operationSuccessSchema,
  storedOperationSchema,
} from '../shared/domain-schemas.js';
import { z } from '../shared/schemas.js';

// Proof that THIS operation reached a final state. Derived from the shared
// response schemas, but tolerant of additive server changes: an extra field on
// a task record must not turn a real success into an outcome the CLI cannot
// confirm (that would leave the envelope in the outbox forever).
const record = z.record(z.string(), z.unknown());
export const acknowledgedSuccessSchema = operationSuccessSchema
  .pick({
    ok: true,
    operationId: true,
    generation: true,
    firstSeq: true,
    lastSeq: true,
    dryRun: true,
  })
  .extend({ results: z.array(record), events: z.array(record) })
  .loose();
export const acknowledgedErrorSchema = operationErrorSchema
  .pick({ ok: true, code: true, message: true, retryable: true })
  .extend({
    operationId: operationErrorSchema.shape.operationId,
    generation: operationErrorSchema.shape.generation,
  })
  .loose();
export const acknowledgedStoredSchema = storedOperationSchema
  .pick({ id: true, status: true, ok: true })
  .extend({ result: record })
  .loose();

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export type Acknowledgement =
  | { kind: 'confirmed' }
  | { kind: 'rejected'; exit: 1 | 3 | 4 }
  | { kind: 'retryable' }
  | { kind: 'unknown'; reason: string };

export function rejectionExit(
  code: unknown,
  status: number | undefined,
): 1 | 3 | 4 {
  if (
    status === 401 ||
    status === 403 ||
    code === 'unauthorized' ||
    code === 'forbidden'
  )
    return 4;
  if (
    status === 409 ||
    code === 'conflict' ||
    code === 'operation_mismatch' ||
    code === 'generation_changed' ||
    code === 'not_undoable'
  )
    return 3;
  return 1;
}

// The one place that decides whether a reply settles an envelope.
//   confirmed  ok: true, same operationId and generation, HTTP 2xx    → remove, exit 0
//   rejected   ok: false, retryable: false, HTTP ≥ 400, same or no id → remove, exit 1/3/4
//   retryable  ok: false, retryable: true                              → keep, retry, exit 1
//   unknown    anything else (2xx without ok, {}, foreign id, non-JSON) → keep, exit 1
export function acknowledge(
  reply: Reply,
  envelope: { operationId: string; generation: string },
): Acknowledgement {
  const success = acknowledgedSuccessSchema.safeParse(reply.body);
  if (success.success) {
    if (success.data.operationId !== envelope.operationId)
      return {
        kind: 'unknown',
        reason: 'operationId в ответе не совпадает с конвертом',
      };
    if (success.data.generation !== envelope.generation)
      return {
        kind: 'unknown',
        reason: 'generation в ответе не совпадает с конвертом',
      };
    if (reply.status < 200 || reply.status >= 300)
      return {
        kind: 'unknown',
        reason: `успешное тело при HTTP ${reply.status}`,
      };
    return { kind: 'confirmed' };
  }
  const failure = acknowledgedErrorSchema.safeParse(reply.body);
  if (failure.success) {
    if (
      failure.data.operationId !== undefined &&
      failure.data.operationId !== envelope.operationId
    )
      return {
        kind: 'unknown',
        reason: 'operationId отказа не совпадает с конвертом',
      };
    if (failure.data.retryable) return { kind: 'retryable' };
    if (reply.status < 400)
      return {
        kind: 'unknown',
        reason: `окончательный отказ при HTTP ${reply.status}`,
      };
    return {
      kind: 'rejected',
      exit: rejectionExit(failure.data.code, reply.status),
    };
  }
  return {
    kind: 'unknown',
    reason:
      reply.body.code === 'invalid_response'
        ? 'ответ без JSON'
        : 'ответ сервера не подтверждает операцию',
  };
}

// GET /api/operations/{id}: the stored result is classified by the same rule.
export function acknowledgeStored(
  reply: Reply,
  envelope: { operationId: string; generation: string },
): { acknowledgement: Acknowledgement; stored?: Reply } {
  if (reply.status < 200 || reply.status >= 300)
    return {
      acknowledgement: {
        kind: 'unknown',
        reason: `HTTP ${reply.status} при чтении операции`,
      },
    };
  const parsed = acknowledgedStoredSchema.safeParse(reply.body);
  if (!parsed.success)
    return {
      acknowledgement: {
        kind: 'unknown',
        reason: 'ответ не является сохранённой операцией',
      },
    };
  if (parsed.data.id !== envelope.operationId)
    return {
      acknowledgement: {
        kind: 'unknown',
        reason: 'id сохранённой операции не совпадает с конвертом',
      },
    };
  const stored = { status: parsed.data.status, body: parsed.data.result };
  return { acknowledgement: acknowledge(stored, envelope), stored };
}

export function unconfirmed(
  operationId: string,
  status: number,
  reason: string,
): Reply {
  return {
    status: status >= 400 ? status : 502,
    body: {
      ok: false,
      code: 'invalid_response',
      status: 'unknown',
      operationId,
      retryable: true,
      httpStatus: status,
      reason,
      message:
        'Ответ сервера не подтверждает операцию; конверт сохранён, проверьте taskindex operation get <id>',
    },
  };
}
