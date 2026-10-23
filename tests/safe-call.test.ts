import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { safeCall } from '@/lib/gateway/safe-call';
import type { FaultMode } from '@/lib/types';

const schema = z.object({ value: z.number() });
const fast = { timeoutMs: 50, backoffMs: 1, maxAttempts: 2 };

function run(fault: FaultMode, call: () => Promise<unknown> = async () => ({ value: 1 })) {
  return safeCall({ service: 'shipments', fault, schema, call, options: fast });
}

describe('safeCall', () => {
  it('returns data on success in one attempt', async () => {
    expect(await run('none')).toEqual({ ok: true, data: { value: 1 }, attempts: 1 });
  });

  it('recovers from a single failure with one retry', async () => {
    const result = await run('flaky');
    expect(result).toEqual({ ok: true, data: { value: 1 }, attempts: 2 });
  });

  it('gives up after two attempts on a persistent server error', async () => {
    const result = await run('server_error');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(2);
      expect(result.error).toMatchObject({ code: 'server_error', retryable: true, attempts: 2 });
      expect(result.error.message).toContain('shipment tracking service');
    }
  });

  it('times out a hanging call instead of waiting for it', async () => {
    const started = Date.now();
    const result = await run('timeout');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timeout');
  });

  it('times out a slow real call too', async () => {
    const result = await run('none', () => new Promise((r) => setTimeout(() => r({ value: 1 }), 200)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timeout');
  });

  it('catches a malformed response', async () => {
    const result = await run('malformed');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed_response');
  });

  it('reports rate limiting', async () => {
    const result = await safeCall({
      service: 'orders',
      fault: 'rate_limited',
      schema,
      call: async () => ({ value: 1 }),
      options: { timeoutMs: 1000, maxAttempts: 2 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('rate_limited');
  });

  it('does not retry an unexpected error', async () => {
    let calls = 0;
    const result = await run('none', async () => {
      calls += 1;
      throw new Error('boom');
    });
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: 'internal_error', retryable: false });
  });
});
