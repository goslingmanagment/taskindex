import type { ErrorCode, OperationError } from './model.js';
// The one shape of an error body. Only SQLite availability errors are
// retryable with the same envelope; every other code is a final outcome.
export function errorBody(
  code: ErrorCode,
  message: string,
  extra: Partial<OperationError> = {},
): OperationError {
  return {
    ok: false,
    code,
    message,
    retryable: code === 'unavailable',
    ...extra,
  };
}
// `['payload', 'title']` -> `payload.title`, `['commands', 2, 'payload']` ->
// `commands[2].payload`. Used for `issues[].path` on the server and in the CLI.
export function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (acc, key) =>
      typeof key === 'number'
        ? `${acc}[${key}]`
        : acc
          ? `${acc}.${String(key)}`
          : String(key),
    '',
  );
}
export function assertNever(
  value: never,
  message = 'Необработанный вариант',
): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Partial<OperationError>;
  constructor(
    code: ErrorCode,
    message: string,
    details: Partial<OperationError> = {},
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
    this.status = {
      invalid: 400,
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      conflict: 409,
      operation_mismatch: 409,
      generation_changed: 409,
      not_undoable: 409,
      unavailable: 503,
      internal: 500,
    }[code];
  }
  toJSON(): OperationError {
    return errorBody(this.code, this.message, this.details);
  }
}
export function fail(
  code: ErrorCode,
  message: string,
  details: Partial<OperationError> = {},
): never {
  throw new DomainError(code, message, details);
}
