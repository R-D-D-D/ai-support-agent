// Allowlisted response shapes. The gateway copies only these fields out of
// backend records, so staff-only fields (such as internal notes) and other
// customers' data never reach the model.

import { untrusted, type UntrustedText } from '@/lib/gateway/untrusted';
import type { Order, Refund, RefundRequest, Shipment, Ticket } from '@/lib/types';

export interface OrderSummaryDto {
  orderId: string;
  placedAt: string;
  status: Order['status'];
  total: number;
  currency: string;
  items: string;
}

export function orderSummaryDto(o: Order): OrderSummaryDto {
  return {
    orderId: o.id,
    placedAt: o.placedAt,
    status: o.status,
    total: o.total,
    currency: o.currency,
    items: o.items.map((i) => `${i.name} x${i.quantity}`).join(', '),
  };
}

export function refundDto(r: Refund) {
  return {
    refundId: r.id,
    orderId: r.orderId,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    createdAt: r.createdAt,
  };
}

export function ticketDto(t: Ticket) {
  return {
    ticketId: t.id,
    orderId: t.orderId,
    status: t.status,
    priority: t.priority,
    createdAt: t.createdAt,
  };
}

// Status of a staff refund request. The agent note and internal review
// details stay out; the staff decision note is meant for the customer.
export function refundRequestDto(r: RefundRequest) {
  return {
    requestId: r.id,
    orderId: r.orderId,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    reviewReasons: r.reviewReasons,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    refundId: r.refundId,
  };
}

export function orderDetailDto(
  o: Order,
  refund: Refund | null,
  request: RefundRequest | null,
  ticket: Ticket | null,
) {
  return {
    orderId: o.id,
    placedAt: o.placedAt,
    status: o.status,
    items: o.items.map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: i.unitPrice })),
    total: o.total,
    currency: o.currency,
    refund: refund ? refundDto(refund) : null,
    refundRequest: request ? refundRequestDto(request) : null,
    openTicket: ticket ? ticketDto(ticket) : null,
  };
}

export interface ShipmentDto {
  orderId: string;
  carrier: string;
  trackingNumber: string;
  status: Shipment['status'];
  estimatedDelivery: string;
  deliveredAt: string | null;
  events: Shipment['events'];
  carrierNote: UntrustedText | null;
}

export function shipmentDto(s: Shipment): ShipmentDto {
  return {
    orderId: s.orderId,
    carrier: s.carrier,
    trackingNumber: s.trackingNumber,
    status: s.status,
    estimatedDelivery: s.estimatedDelivery,
    deliveredAt: s.deliveredAt,
    events: s.events.map((e) => ({ at: e.at, location: e.location, description: e.description })),
    carrierNote: s.carrierNote ? untrusted(s.carrierNote) : null,
  };
}
