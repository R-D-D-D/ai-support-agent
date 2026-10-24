// Refund requests waiting for staff, with the order facts needed to decide.

import { requireStaff } from '@/lib/auth/current-customer';
import { listRequestsForStaff } from '@/lib/staff/decide';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const auth = await requireStaff(req);
  if ('response' in auth) return auth.response;
  return Response.json({ requests: listRequestsForStaff() });
}
