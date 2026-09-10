import { afterEach, expect, it, vi } from 'vitest';
import { request, ApiError } from '../../src/web/app/api';

afterEach(() => vi.unstubAllGlobals());

it('reads a known rejected operation as data rather than a failed GET', async () => {
  const record = {
    id: 'known-operation',
    status: 404,
    ok: false,
    errorCode: 'not_found',
    errorMessage: 'Запись не найдена.',
    result: {
      ok: false,
      code: 'not_found',
      retryable: false,
      message: 'Запись не найдена.',
    },
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(record)));
  await expect(request('/api/operations/known-operation')).resolves.toEqual(
    record,
  );
});

it('retains the terminal error when the operation itself is unknown', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json(
        {
          ok: false,
          code: 'not_found',
          retryable: false,
          message: 'Операция пока неизвестна серверу.',
        },
        { status: 404 },
      ),
    ),
  );
  const result = request('/api/operations/unknown-operation');
  await expect(result).rejects.toBeInstanceOf(ApiError);
  await expect(result).rejects.toMatchObject({
    status: 404,
    detail: { code: 'not_found', retryable: false },
  });
});
