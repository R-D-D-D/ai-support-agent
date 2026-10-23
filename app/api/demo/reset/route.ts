// Demo control: restores the signed-in customer's data to the seed state.
// Other customers' data is not touched.

import { getSessionCustomer } from '@/lib/auth/current-customer';
import { unauthorized } from '@/lib/auth/session';
import { isRunLocked } from '@/lib/agent/run-lock';
import { resetCustomer } from '@/lib/data/store';

export async function POST(req: Request): Promise<Response> {
  const customer = await getSessionCustomer(req);
  if (!customer) return unauthorized();
  if (isRunLocked(customer.id)) {
    return Response.json(
      { error: 'run_in_progress', message: 'Wait for the assistant to finish first.' },
      { status: 409 },
    );
  }
  resetCustomer(customer.id);
  return Response.json({ ok: true });
}
