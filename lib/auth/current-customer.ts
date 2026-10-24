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

export function forbidden(message = 'You do not have access to this.'): Response {
  return Response.json({ error: 'forbidden', message }, { status: 403 });
}

// For staff-only routes. Returns the staff member, or the response to send.
export async function requireStaff(req: Request): Promise<{ staff: Customer } | { response: Response }> {
  const user = await getSessionCustomer(req);
  if (!user) return { response: Response.json({ error: 'unauthorized', message: 'Please sign in.' }, { status: 401 }) };
  if (user.role !== 'staff') return { response: forbidden('Staff only.') };
  return { staff: user };
}
