// Fault injector. Wraps a service call and makes it misbehave on purpose so
// the demo can show how the agent handles backend failures.

import { ServiceError } from '@/lib/services/errors';
import type { FaultMode } from '@/lib/types';

// How long a "timeout" fault hangs. Longer than the gateway's own timeout, so
// the gateway gives up first.
export const HANG_MS = 30_000;

export async function withFault<T>(
  mode: FaultMode,
  attempt: number,
  call: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T | unknown> {
  switch (mode) {
    case 'none':
      return call();
    case 'flaky':
      if (attempt === 1) {
        throw new ServiceError('server_error', 'Upstream service returned HTTP 503.', true);
      }
      return call();
    case 'timeout':
      await hang(signal);
      return call();
    case 'server_error':
      throw new ServiceError('server_error', 'Upstream service returned HTTP 500.', true);
    case 'rate_limited':
      throw new ServiceError('rate_limited', 'Upstream service returned HTTP 429.', true, 300);
    case 'malformed':
      // A response that does not match the expected shape at all.
      return { status: 502, body: '<html><body>Bad Gateway</body></html>' };
  }
}

// Waits HANG_MS, or stops early when the caller aborts.
function hang(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, HANG_MS);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new ServiceError('timeout', 'Request aborted.', true));
    });
  });
}
