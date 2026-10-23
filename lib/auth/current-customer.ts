// Resolves the signed-in customer for a request from the verified session cookie.

import { readCookie, SESSION_COOKIE, verifySessionToken } from '@/lib/auth/session';
import { getStore } from '@/lib/data/store';
import type { Customer } from '@/lib/types';

// Looks up the signed-in customer for a request. Returns null when the cookie
// is missing, tampered with, expired, or names a customer that does not exist.
export async function getSessionCustomer(req: Request): Promise<Customer | null> {
  const customerId = await verifySessionToken(readCookie(req, SESSION_COOKIE));
  if (!customerId) return null;
  return getStore().customers.find((c) => c.id === customerId) ?? null;
}
