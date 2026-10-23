// Checks an email and password against the customer store.

import { DUMMY_HASH, verifyPassword } from '@/lib/auth/password';
import { isLocked, recordFailure, recordSuccess } from '@/lib/auth/login-limiter';
import { getStore } from '@/lib/data/store';
import type { Customer } from '@/lib/types';

export type LoginResult =
  | { ok: true; customer: Customer }
  | { ok: false; reason: 'invalid_credentials' | 'locked' };

export function attemptLogin(rawEmail: string, password: string, now = Date.now()): LoginResult {
  const email = rawEmail.trim().toLowerCase();
  if (isLocked(email, now)) return { ok: false, reason: 'locked' };

  const customer = getStore().customers.find((c) => c.email === email);
  // Always run one hash check, even for unknown emails, so response time does
  // not reveal which emails have accounts.
  const valid = verifyPassword(password, customer?.passwordHash ?? DUMMY_HASH);

  if (!customer || !valid) {
    recordFailure(email, now);
    return { ok: false, reason: 'invalid_credentials' };
  }
  recordSuccess(email);
  return { ok: true, customer };
}
