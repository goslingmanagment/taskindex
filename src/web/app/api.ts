import type { z } from 'zod';
import type { OperationError } from '@shared/model';
export class ApiError extends Error {
  constructor(
    public detail: OperationError,
    public status = 0,
  ) {
    super(detail.message);
  }
  get current() {
    return this.detail.current;
  }
}
// A successful HTTP response outside this bundle's contract does not establish
// the outcome of a write. Editors keep its intent; the store stops sending until
// a reload brings a compatible bundle (TI-086).
export class ContractMismatch extends ApiError {}
// TI-005: every answer of the server is parsed by the shared schema before the
// store sees it. A body that does not match the contract is a failure of the
// request, not data: the client must not build state out of it.
export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has('Content-Type'))
      headers.set('Content-Type', 'application/json');
    response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
      signal: init.signal ?? AbortSignal.timeout(15000),
      headers,
    });
  } catch {
    throw new ApiError({
      ok: false,
      code: 'unavailable',
      retryable: true,
      message: 'Изменение не подтверждено. Проверьте соединение.',
    });
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ApiError(
      {
        ok: false,
        code: 'unavailable',
        retryable: true,
        message: 'Не удалось прочитать ответ сервера.',
      },
      response.status,
    );
  }
  if (
    !response.ok ||
    (value &&
      typeof value === 'object' &&
      'ok' in value &&
      value.ok === false &&
      'code' in value &&
      'retryable' in value)
  ) {
    const data = value as Partial<OperationError>;
    throw new ApiError(
      {
        ok: false,
        code:
          data.code ??
          (response.status === 401 ? 'unauthorized' : 'unavailable'),
        message: data.message ?? 'Не удалось выполнить запрос.',
        retryable: data.retryable ?? response.status >= 500,
        ...(data.current ? { current: data.current } : {}),
      },
      response.status,
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ContractMismatch(
      {
        ok: false,
        code: 'unavailable',
        retryable: true,
        message: 'Ответ сервера не соответствует контракту.',
      },
      response.status,
    );
  return parsed.data;
}
