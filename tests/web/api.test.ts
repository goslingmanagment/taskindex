import { z } from 'zod';
import { afterEach, expect, it, vi } from 'vitest';
import { request, ApiError, ContractMismatch } from '../../src/web/app/api';

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
  await expect(
    request('/api/operations/known-operation', z.looseObject({})),
  ).resolves.toEqual(record);
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
  const result = request(
    '/api/operations/unknown-operation',
    z.looseObject({}),
  );
  await expect(result).rejects.toBeInstanceOf(ApiError);
  await expect(result).rejects.toMatchObject({
    status: 404,
    detail: { code: 'not_found', retryable: false },
  });
});

it('не пускает в состояние тело, которое не соответствует контракту', async () => {
  // TI-005: тело есть, статус 200, но полей контракта в нём нет. Это не данные,
  // а сбой запроса: клиент не должен строить из него состояние.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ tasks: 'не массив' })),
  );
  const schema = z.object({ tasks: z.array(z.string()) });
  await expect(request('/api/snapshot', schema)).rejects.toMatchObject({
    detail: { code: 'unavailable', retryable: true },
    message: 'Ответ сервера не соответствует контракту.',
  });
});

it('TI-086 classifies an incompatible 2xx body as an unknown outcome', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ ok: true, unexpected: 1 })),
  );
  const result = request(
    '/api/commands',
    z.strictObject({ ok: z.literal(true) }),
    { method: 'POST', body: '{}' },
  );
  await expect(result).rejects.toBeInstanceOf(ContractMismatch);
  await expect(result).rejects.toMatchObject({
    status: 200,
    // The editor retains its submission and operationId for unknown outcomes.
    detail: { code: 'unavailable', retryable: true },
  });
});
