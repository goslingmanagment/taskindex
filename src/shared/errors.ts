import type { ErrorCode, OperationError } from './model.js';
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
    }[code];
  }
  toJSON(): OperationError {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      retryable: this.code === 'unavailable',
      ...this.details,
    };
  }
}
export function fail(
  code: ErrorCode,
  message: string,
  details: Partial<OperationError> = {},
): never {
  throw new DomainError(code, message, details);
}
