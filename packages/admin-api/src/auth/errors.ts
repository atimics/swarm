export class AuthError extends Error {
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(message: string, statusCode: number, details?: unknown) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}
