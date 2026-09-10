import { describe, expect, it } from 'vitest';
import { authErrorMessage } from '../../src/web/app/auth-errors';

describe('TI-030 authentication failures are shown in Russian', () => {
  it.each([
    [
      {
        code: 'INVALID_EMAIL_OR_PASSWORD',
        message: 'Invalid email or password',
        status: 401,
      },
      'Неверная почта или пароль.',
    ],
    [{ code: 'INVALID_TOKEN', status: 401 }, 'Сессия истекла. Войдите снова.'],
    [
      { code: 'AUTH_CANCELLED', message: 'Auth cancelled', status: 400 },
      'Вход по passkey отменён.',
    ],
    [
      { code: 'UNKNOWN', message: 'Too many requests', status: 429 },
      'Слишком много попыток. Подождите минуту и повторите.',
    ],
    [
      { code: 'SOMETHING_NEW', message: 'Something new', status: 400 },
      'Не удалось войти. Код: SOMETHING_NEW.',
    ],
    [
      { message: 'Internal', status: 500 },
      'Сервер недоступен. Попробуйте позже (код 500).',
    ],
    [
      new TypeError('Failed to fetch'),
      'Нет связи с сервером. Проверьте соединение.',
    ],
    [
      { message: 'Failed to fetch', status: 500, statusText: 'Fetch Error' },
      'Нет связи с сервером. Проверьте соединение.',
    ],
    [undefined, 'Не удалось войти.'],
  ])('%o → %s', (failure, expected) => {
    expect(authErrorMessage(failure, 'signIn')).toBe(expected);
  });
  it('keeps the action in the fallback of passkey registration', () => {
    expect(
      authErrorMessage({ code: 'FAILED_TO_UPDATE_PASSKEY' }, 'addPasskey'),
    ).toBe('Не удалось сохранить passkey.');
    expect(authErrorMessage({ status: 400 }, 'addPasskey')).toBe(
      'Не удалось добавить passkey.',
    );
    expect(authErrorMessage({ status: 400 }, 'passkey')).toBe(
      'Не удалось войти по passkey.',
    );
  });
  it('never leaks the English server message', () => {
    for (const failure of [
      {
        code: 'INVALID_EMAIL_OR_PASSWORD',
        message: 'Invalid email or password',
      },
      { message: 'Invalid email or password' },
      new TypeError('Failed to fetch'),
    ])
      expect(authErrorMessage(failure, 'signIn')).not.toMatch(/[A-Za-z]{3,}/u);
  });
});
