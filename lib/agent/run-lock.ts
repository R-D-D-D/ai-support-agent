// One agent run at a time per customer session. A second request while a run
// is in progress (for example from another tab) is refused with 409.
// Locks expire so a crashed run cannot block the customer for good.
// In memory, so this is per server instance.

export const LOCK_TTL_MS = 60_000;

interface Lock {
  runId: string;
  expiresAt: number;
}

const globalForLocks = globalThis as unknown as { __runLocks?: Map<string, Lock> };
const locks = (globalForLocks.__runLocks ??= new Map());

export function acquireRunLock(key: string, runId: string, now = Date.now()): boolean {
  const current = locks.get(key);
  if (current && current.expiresAt > now) return false;
  locks.set(key, { runId, expiresAt: now + LOCK_TTL_MS });
  return true;
}

// Releases the lock only if it is still held by this run, so a late release
// from an expired run cannot unlock a newer run.
export function releaseRunLock(key: string, runId: string): void {
  if (locks.get(key)?.runId === runId) locks.delete(key);
}

export function isRunLocked(key: string, now = Date.now()): boolean {
  const current = locks.get(key);
  return !!current && current.expiresAt > now;
}

export function resetRunLocks(): void {
  locks.clear();
}
