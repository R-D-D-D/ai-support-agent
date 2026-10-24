// Staff decisions on refund requests the bot was not allowed to grant.
//
// Staff may override the bot's limits (amount, missing package, risk flag and
// so on), since that is why the request reached them. Before paying, the
// server still rechecks the facts: the request is pending, the order still
// belongs to the customer, nothing has been refunded since, and the amount is
// the stored order total.

import { getStore } from '@/lib/data/store';
import { createRefund } from '@/lib/services/refunds';
import type { Customer, Refund, RefundRequest } from '@/lib/types';

export type DecisionResult =
  | { ok: true; request: RefundRequest; refund: Refund | null }
  | { ok: false; status: number; error: string; message: string };

export async function decideRefundRequest(input: {
  requestId: string;
  staff: Customer;
  approved: boolean;
  note?: string;
}): Promise<DecisionResult> {
  const store = getStore();
  const request = store.refundRequests.find((r) => r.id === input.requestId);
  if (!request) return { ok: false, status: 404, error: 'not_found', message: 'No such refund request.' };
  if (request.status !== 'pending') {
    return { ok: false, status: 409, error: 'already_decided', message: `This request was already ${request.status}.` };
  }

  const order = store.orders.find((o) => o.id === request.orderId);
  if (!order || order.customerId !== request.customerId) {
    return { ok: false, status: 409, error: 'order_mismatch', message: 'The order no longer matches this request.' };
  }

  const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
  const decide = (status: 'approved' | 'denied') => {
    request.status = status;
    request.decidedAt = new Date().toISOString();
    request.decidedBy = input.staff.id;
    request.decisionNote = note;
  };

  if (!input.approved) {
    decide('denied');
    return { ok: true, request: structuredClone(request), refund: null };
  }

  if (store.refunds.some((r) => r.orderId === order.id)) {
    return { ok: false, status: 409, error: 'already_refunded', message: 'This order has already been refunded.' };
  }

  // Claim the request before any await, so two staff members approving at the
  // same moment cannot both pay.
  decide('approved');
  try {
    const { refund } = await createRefund({
      orderId: order.id,
      customerId: order.customerId,
      amount: order.total,
      reason: `Approved by ${input.staff.name}${note ? `: ${note}` : '.'}`,
      issuedBy: input.staff.id,
      requestId: request.id,
    });
    request.refundId = refund.id;
    request.amount = order.total;
    return { ok: true, request: structuredClone(request), refund };
  } catch (err) {
    request.status = 'pending';
    request.decidedAt = null;
    request.decidedBy = null;
    request.decisionNote = null;
    throw err;
  }
}

// Everything a staff member needs to decide, newest pending first.
export function listRequestsForStaff() {
  const store = getStore();
  const name = (id: string | null) => store.customers.find((c) => c.id === id)?.name ?? id;
  return [...store.refundRequests]
    .sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.createdAt.localeCompare(a.createdAt))
    .map((r) => {
      const order = store.orders.find((o) => o.id === r.orderId);
      const shipment = store.shipments.find((s) => s.orderId === r.orderId);
      const customer = store.customers.find((c) => c.id === r.customerId);
      const lastScan = shipment?.events.length
        ? shipment.events.reduce((a, b) => (a.at > b.at ? a : b)).at
        : null;
      return {
        ...r,
        decidedByName: name(r.decidedBy),
        customer: customer ? { name: customer.name, email: customer.email } : null,
        order: order
          ? {
              id: order.id,
              placedAt: order.placedAt,
              total: order.total,
              items: order.items.map((i) => `${i.name} x${i.quantity}`).join(', '),
              riskFlag: order.riskFlag,
              paymentStatus: order.paymentStatus,
              internalNotes: order.internalNotes,
            }
          : null,
        shipment: shipment
          ? {
              carrier: shipment.carrier,
              status: shipment.status,
              estimatedDelivery: shipment.estimatedDelivery,
              deliveredAt: shipment.deliveredAt,
              lastScan,
              carrierNote: shipment.carrierNote,
            }
          : null,
      };
    });
}

export type StaffRequestView = ReturnType<typeof listRequestsForStaff>[number];
