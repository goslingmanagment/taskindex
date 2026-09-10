import { ArgumentError } from './arguments.js';
import { storedOperationSchema } from '../shared/domain-schemas.js';
import {
  acknowledge,
  acknowledgeStored,
  rejectionExit,
  unconfirmed,
} from './acknowledge.js';
import type { Outbox, SavedOperation } from './outbox.js';

export interface ApiReply {
  status: number;
  body: Record<string, unknown>;
}
export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

// Exit code of a reply that is printed as is (reads and settled writes).
export function exitCode(reply: ApiReply): number {
  // A successful GET can describe a rejected operation with its own ok: false.
  if (
    reply.status >= 200 &&
    reply.status < 300 &&
    storedOperationSchema.safeParse(reply.body).success
  )
    return 0;
  if (reply.status >= 200 && reply.status < 300 && reply.body.ok !== false)
    return 0;
  return rejectionExit(reply.body.code, reply.status);
}

// One transport for every request: plain `fetch` against this API origin.
// The envelopes are validated by the shared schemas before they are sent,
// and every reply is classified by `acknowledge`, so no typed RPC client is
// needed and the CLI does not depend on the server's types.
export class ApiClient {
  readonly baseUrl: string;
  private readonly requestFetch: typeof fetch;
  constructor(readonly options: ClientOptions) {
    const url = new URL(options.baseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new ArgumentError(
        'TASKINDEX_URL: ожидается HTTP(S) URL без credentials, query и hash',
      );
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.requestFetch = options.fetch ?? fetch;
  }

  async request(path: string, envelope?: unknown): Promise<ApiReply> {
    // Follow pagination only within this API origin, never leak a bearer token.
    const target = new URL(path, `${this.baseUrl}/`);
    if (target.origin !== new URL(this.baseUrl).origin)
      throw new ArgumentError('API вернул ссылку на другой сервер');
    const request: RequestInit = {
      method: envelope === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        accept: 'application/json',
        ...(envelope === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      ...(envelope === undefined ? {} : { body: JSON.stringify(envelope) }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      redirect: 'error',
    };
    const response = await this.requestFetch(target, request);
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        status: response.status || 502,
        body: {
          ok: false,
          code: 'invalid_response',
          message: 'Сервер вернул ответ без JSON',
          retryable: true,
        },
      };
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body))
      body = { data: body };
    return { status: response.status, body: body as Record<string, unknown> };
  }

  // The outbox is the durable record of intent: the envelope is written before
  // the first attempt and removed only after `acknowledge` proves a final
  // outcome of this very operation (same operationId and generation).
  async send(outbox: Outbox, operation: SavedOperation): Promise<ApiReply> {
    if (operation.baseUrl !== this.baseUrl)
      throw new ArgumentError(
        'Сохранённая операция относится к другому TASKINDEX_URL',
      );
    await outbox.put(operation);
    const { envelope } = operation;
    let finalReply: ApiReply | undefined;
    let unknown = false;
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      if (attempt)
        await (
          this.options.sleep ??
          ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
        )(250 * 2 ** (attempt - 1));
      try {
        const reply = await this.request(operation.endpoint, envelope);
        finalReply = reply;
        const outcome = acknowledge(reply, envelope);
        if (outcome.kind === 'confirmed' || outcome.kind === 'rejected') {
          await outbox.remove(envelope.operationId);
          return reply;
        }
        if (outcome.kind === 'unknown') {
          // A 2xx that is not a TaskIndex result comes from something other
          // than the command handler (wrong URL, maintenance page): a retry
          // cannot change that, and the outcome must be inspected instead.
          if (reply.status >= 200 && reply.status < 300)
            return unconfirmed(
              envelope.operationId,
              reply.status,
              outcome.reason,
            );
          // A proxy 5xx or malformed response is not proof that a commit did
          // not happen. Keep exactly the original envelope and retry it.
          unknown = true;
        }
      } catch (error) {
        if (error instanceof ArgumentError) throw error;
        unknown = true;
      }
    }
    return {
      status:
        finalReply?.status && finalReply.status >= 400
          ? finalReply.status
          : 503,
      body: {
        ...finalReply?.body,
        ok: false,
        operationId: envelope.operationId,
        retryable: true,
        ...(unknown || !finalReply
          ? {
              status: 'unknown',
              code: 'network_error',
              message:
                'Исход операции неизвестен; используйте operation get или operation resume с тем же ID',
            }
          : {}),
      },
    };
  }

  async resume(outbox: Outbox, operation: SavedOperation): Promise<ApiReply> {
    if (operation.baseUrl !== this.baseUrl)
      throw new ArgumentError(
        'Сохранённая операция относится к другому TASKINDEX_URL',
      );
    const { envelope } = operation;
    let state: ApiReply;
    try {
      state = await this.request(
        `/api/operations/${encodeURIComponent(envelope.operationId)}`,
      );
    } catch {
      return {
        status: 503,
        body: {
          ok: false,
          code: 'network_error',
          retryable: true,
          status: 'unknown',
          operationId: envelope.operationId,
          message:
            'Не удалось выяснить исход операции; сохранённый конверт оставлен для повтора',
        },
      };
    }
    // No record of this id: the idempotent endpoint resolves it.
    if (state.status === 404) return this.send(outbox, operation);
    if (state.status < 200 || state.status >= 300) return state;
    const { acknowledgement, stored } = acknowledgeStored(state, envelope);
    switch (acknowledgement.kind) {
      case 'confirmed':
        await outbox.remove(envelope.operationId);
        return { status: 200, body: stored!.body };
      case 'rejected':
        await outbox.remove(envelope.operationId);
        return stored!;
      case 'retryable':
        return this.send(outbox, operation);
      case 'unknown':
        return unconfirmed(
          envelope.operationId,
          state.status,
          acknowledgement.reason,
        );
    }
  }
}
