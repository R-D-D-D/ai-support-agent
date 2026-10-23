// Blocks an email after too many failed sign-in attempts. In memory, so it is
// per server instance.

export const MAX_FAILURES = 5;
export const WINDOW_MS = 5 * 60 * 1000;

interface Entry {
  failures: number;
  windowStart: number;
}

const globalForLimiter = globalThis as unknown as { __loginLimiter?: Map<string, Entry> };
const entries = (globalForLimiter.__loginLimiter ??= new Map());

export function isLocked(email: string, now = Date.now()): boolean {
  const entry = entries.get(email);
  if (!entry) return false;
  if (now - entry.windowStart > WINDOW_MS) {
    entries.delete(email);
    return false;
  }
  return entry.failures >= MAX_FAILURES;
}

export function recordFailure(email: string, now = Date.now()): void {
  const entry = entries.get(email);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    entries.set(email, { failures: 1, windowStart: now });
  } else {
    entry.failures += 1;
  }
}

export function recordSuccess(email: string): void {
  entries.delete(email);
}

export function resetLimiter(): void {
  entries.clear();
}
