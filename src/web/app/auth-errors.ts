// TI-030: Russian texts for authentication failures, keyed by the stable
// better-auth / passkey error code. The code stays visible in the technical
// suffix so a report can still be matched with the server log; the server's
// English message is never shown as is.
type AuthFailure = {
  code?: string;
  message?: string;
  status?: number;
  statusText?: string;
};
const known: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: 'Неверная почта или пароль.',
  INVALID_EMAIL: 'Почта указана неверно.',
  INVALID_PASSWORD: 'Неверный пароль.',
  USER_NOT_FOUND: 'Неверная почта или пароль.',
  USER_EMAIL_NOT_FOUND: 'Неверная почта или пароль.',
  CREDENTIAL_ACCOUNT_NOT_FOUND: 'Для этой почты вход по паролю не настроен.',
  EMAIL_NOT_VERIFIED: 'Почта ещё не подтверждена.',
  EMAIL_PASSWORD_DISABLED: 'Вход по паролю отключён.',
  FAILED_TO_CREATE_SESSION: 'Не удалось открыть сессию. Попробуйте ещё раз.',
  UNABLE_TO_CREATE_SESSION: 'Не удалось открыть сессию. Попробуйте ещё раз.',
  SESSION_EXPIRED: 'Сессия истекла. Войдите снова.',
  INVALID_TOKEN: 'Сессия истекла. Войдите снова.',
  AUTH_CANCELLED: 'Вход по passkey отменён.',
  AUTHENTICATION_FAILED: 'Passkey не подтверждён. Попробуйте ещё раз.',
  CHALLENGE_NOT_FOUND: 'Проверка passkey устарела. Попробуйте ещё раз.',
  PASSKEY_NOT_FOUND: 'Такой passkey не зарегистрирован.',
  ERROR_CEREMONY_ABORTED: 'Действие с passkey отменено.',
  REGISTRATION_CANCELLED: 'Добавление passkey отменено.',
  ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED: 'Этот passkey уже добавлен.',
  PREVIOUSLY_REGISTERED: 'Этот passkey уже добавлен.',
  FAILED_TO_VERIFY_REGISTRATION: 'Не удалось подтвердить passkey.',
  YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY: 'Этот passkey добавить нельзя.',
  FAILED_TO_UPDATE_PASSKEY: 'Не удалось сохранить passkey.',
};
const AUTH_FALLBACK = {
  signIn: 'Не удалось войти.',
  passkey: 'Не удалось войти по passkey.',
  addPasskey: 'Не удалось добавить passkey.',
} as const;
const OFFLINE = 'Нет связи с сервером. Проверьте соединение.';
export function authErrorMessage(
  failure: unknown,
  action: keyof typeof AUTH_FALLBACK,
): string {
  const fallback = AUTH_FALLBACK[action];
  if (failure instanceof TypeError) return OFFLINE;
  if (!failure || typeof failure !== 'object') return fallback;
  const { code, status, statusText } = failure as AuthFailure;
  // better-fetch reports a request that never reached the server as a
  // synthetic 500 with this statusText; it is a connection problem, not a
  // server failure, and the two need different advice.
  if (statusText === 'Fetch Error') return OFFLINE;
  if (status === 429)
    return 'Слишком много попыток. Подождите минуту и повторите.';
  if (code && known[code]) return known[code];
  if (status !== undefined && status >= 500)
    return `Сервер недоступен. Попробуйте позже (код ${code || status}).`;
  return code ? `${fallback} Код: ${code}.` : fallback;
}
