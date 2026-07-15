export type AppServerErrorCode =
  | 'cli-not-found'
  | 'process-start-failed'
  | 'connection-closed'
  | 'request-timeout'
  | 'request-failed'
  | 'protocol-error'
  | 'disposed';

export class AppServerError extends Error {
  public constructor(
    public readonly code: AppServerErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AppServerError';
  }
}

export class AppServerRequestError extends AppServerError {
  public constructor(
    public readonly method: string,
    public readonly requestCode: number,
    message: string
  ) {
    super('request-failed', `${method} failed (${requestCode}): ${message}`);
    this.name = 'AppServerRequestError';
  }
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
