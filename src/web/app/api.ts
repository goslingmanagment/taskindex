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
export async function request<T>(
  path: string,
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
  return value as T;
}
