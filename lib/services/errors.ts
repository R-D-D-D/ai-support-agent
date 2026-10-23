// Error thrown by simulated backend services.

export type ServiceErrorCode =
  | 'not_found'
  | 'timeout'
  | 'server_error'
  | 'rate_limited'
  | 'conflict';

export class ServiceError extends Error {
  constructor(
    public readonly code: ServiceErrorCode,
    message: string,
    public readonly retryable: boolean,
    // For rate limits: how long the caller should wait before retrying.
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
