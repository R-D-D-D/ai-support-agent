import { beforeEach, describe, expect, it } from 'vitest';
import { acquireRunLock, isRunLocked, LOCK_TTL_MS, releaseRunLock, resetRunLocks } from '@/lib/agent/run-lock';

beforeEach(() => resetRunLocks());

describe('run lock', () => {
  it('refuses a second run for the same customer', () => {
    expect(acquireRunLock('cus_a', 'run-1')).toBe(true);
    expect(acquireRunLock('cus_a', 'run-2')).toBe(false);
  });

  it('does not block other customers', () => {
    acquireRunLock('cus_a', 'run-1');
    expect(acquireRunLock('cus_b', 'run-2')).toBe(true);
  });

  it('allows a new run after release', () => {
    acquireRunLock('cus_a', 'run-1');
    releaseRunLock('cus_a', 'run-1');
    expect(acquireRunLock('cus_a', 'run-2')).toBe(true);
  });

  it('expires so a crashed run cannot block forever', () => {
    const t0 = 1_000_000;
    acquireRunLock('cus_a', 'run-1', t0);
    expect(isRunLocked('cus_a', t0 + LOCK_TTL_MS - 1)).toBe(true);
    expect(acquireRunLock('cus_a', 'run-2', t0 + LOCK_TTL_MS + 1)).toBe(true);
  });

  it('ignores a late release from an older run', () => {
    const t0 = 1_000_000;
    acquireRunLock('cus_a', 'run-1', t0);
    acquireRunLock('cus_a', 'run-2', t0 + LOCK_TTL_MS + 1);
    releaseRunLock('cus_a', 'run-1');
    expect(isRunLocked('cus_a', t0 + LOCK_TTL_MS + 2)).toBe(true);
  });
});
