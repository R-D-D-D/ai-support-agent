// Runs one backend service call with a timeout, one retry for temporary
// failures, and validation of the response shape. Converts every failure into
// a ToolError instead of throwing.

import type { z } from 'zod';
import { ServiceError } from '@/lib/services/errors';
import { withFault } from '@/lib/services/faults';
import type { FaultMode, ServiceName } from '@/lib/types';
import type { ToolError } from '@/lib/gateway/types';

export interface SafeCallOptions {
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: number;
}

export const DEFAULT_SAFE_CALL_OPTIONS: SafeCallOptions = {
  timeoutMs: 3000,
  maxAttempts: 2,
  backoffMs: 250,
};

export type SafeCallResult<T> =
  | { ok: true; data: T; attempts: number }
  | { ok: false; error: ToolError; attempts: number };

const SERVICE_LABEL: Record<ServiceName, string> = {
  orders: 'order service',
  shipments: 'shipment tracking service',
  refunds: 'refund service',
  tickets: 'support ticket service',
};

class MalformedResponseError extends Error {}

export async function safeCall<T>(args: {
  service: ServiceName;
  fault: FaultMode;
  schema: z.ZodType<T>;
  call: () => Promise<unknown>;
  options?: Partial<SafeCallOptions>;
}): Promise<SafeCallResult<T>> {
  const opts = { ...DEFAULT_SAFE_CALL_OPTIONS, ...args.options };

  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    try {
      const raw = await withTimeout(
        withFault(args.fault, attempt, args.call, controller.signal),
        opts.timeoutMs,
        controller,
      );
      const parsed = args.schema.safeParse(raw);
      if (!parsed.success) throw new MalformedResponseError();
      return { ok: true, data: parsed.data, attempts: attempt };
    } catch (err) {
      const error = toToolError(err, args.service, attempt);
      if (!error.retryable || attempt >= opts.maxAttempts) {
        return { ok: false, error, attempts: attempt };
      }
      const waitMs = err instanceof ServiceError && err.retryAfterMs ? err.retryAfterMs : opts.backoffMs;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ServiceError('timeout', 'timed out', true));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function toToolError(err: unknown, service: ServiceName, attempts: number): ToolError {
  const label = SERVICE_LABEL[service];
  const tried = attempts > 1 ? ` after ${attempts} attempts` : '';
  if (err instanceof MalformedResponseError) {
    return {
      code: 'malformed_response',
      message: `The ${label} returned data in an unexpected format${tried}.`,
      retryable: true,
      attempts,
    };
  }
  if (err instanceof ServiceError) {
    switch (err.code) {
      case 'timeout':
        return { code: 'timeout', message: `The ${label} did not respond in time${tried}.`, retryable: true, attempts };
      case 'rate_limited':
        return { code: 'rate_limited', message: `The ${label} is rate limiting requests${tried}.`, retryable: true, attempts };
      case 'server_error':
        return { code: 'server_error', message: `The ${label} returned a server error${tried}.`, retryable: true, attempts };
      case 'not_found':
        return { code: 'not_found', message: err.message, retryable: false, attempts };
      case 'conflict':
        return { code: 'internal_error', message: err.message, retryable: false, attempts };
    }
  }
  return {
    code: 'internal_error',
    message: `Unexpected error while calling the ${label}.`,
    retryable: false,
    attempts,
  };
}
