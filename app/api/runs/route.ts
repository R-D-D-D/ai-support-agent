// Recent agent runs for the signed-in customer (the audit log).

import { getSessionCustomer } from '@/lib/auth/current-customer';
import { unauthorized } from '@/lib/auth/session';
import { listRuns } from '@/lib/agent/run-log';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const customer = await getSessionCustomer(req);
  if (!customer) return unauthorized();
  return Response.json({ runs: listRuns(customer.id, 20) });
}
