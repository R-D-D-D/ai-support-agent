// Side-panel data for the signed-in customer: orders with shipment, refund,
// and ticket details. Reads the store directly; this is the "backstage" view
// for the demo, not something the agent uses.

import { forbidden, getSessionCustomer } from '@/lib/auth/current-customer';
import { unauthorized } from '@/lib/auth/session';
import { getStore } from '@/lib/data/store';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const customer = await getSessionCustomer(req);
  if (!customer) return unauthorized();
  if (customer.role !== 'customer') return forbidden('Staff accounts use the staff page.');

  const store = getStore();
  const orders = store.orders
    .filter((o) => o.customerId === customer.id)
    .sort((a, b) => b.placedAt.localeCompare(a.placedAt))
    .map((o) => ({
      id: o.id,
      placedAt: o.placedAt,
      status: o.status,
      total: o.total,
      currency: o.currency,
      items: o.items,
      shipment: store.shipments.find((s) => s.orderId === o.id) ?? null,
      refund: store.refunds.find((r) => r.orderId === o.id) ?? null,
      refundRequests: store.refundRequests.filter((r) => r.orderId === o.id),
      tickets: store.tickets.filter((t) => t.orderId === o.id),
    }));

  return Response.json({
    customer: { id: customer.id, name: customer.name, email: customer.email },
    orders,
    refunds: store.refunds.filter((r) => r.customerId === customer.id),
    refundRequests: store.refundRequests.filter((r) => r.customerId === customer.id),
    tickets: store.tickets.filter((t) => t.customerId === customer.id),
    serverTime: new Date().toISOString(),
  });
}
