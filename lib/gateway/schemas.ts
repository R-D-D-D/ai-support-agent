// Expected shapes of backend service responses. The gateway checks every
// response against these, so a broken or malformed backend reply is caught
// instead of being passed to the model.

import { z } from 'zod';

export const orderSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  placedAt: z.string(),
  items: z.array(
    z.object({
      sku: z.string(),
      name: z.string(),
      quantity: z.number(),
      unitPrice: z.number(),
    }),
  ),
  total: z.number(),
  currency: z.literal('USD'),
  status: z.enum(['processing', 'shipped', 'delivered', 'cancelled']),
  shipmentId: z.string(),
  riskFlag: z.boolean(),
  paymentStatus: z.enum(['settled', 'pending']),
  internalNotes: z.string(),
});

export const shipmentSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  carrier: z.string(),
  trackingNumber: z.string(),
  status: z.enum(['label_created', 'in_transit', 'out_for_delivery', 'delivered', 'exception']),
  estimatedDelivery: z.string(),
  deliveredAt: z.string().nullable(),
  events: z.array(z.object({ at: z.string(), location: z.string(), description: z.string() })),
  carrierNote: z.string().nullable(),
});

export const refundSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  customerId: z.string(),
  amount: z.number(),
  currency: z.literal('USD'),
  reason: z.string(),
  createdAt: z.string(),
  status: z.literal('issued'),
  issuedBy: z.string(),
  requestId: z.string().nullable(),
});

export const refundRequestSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  customerId: z.string(),
  amount: z.number(),
  currency: z.literal('USD'),
  claim: z.enum(['delayed', 'missing']),
  reviewReasons: z.array(z.string()),
  agentNote: z.string(),
  status: z.enum(['pending', 'approved', 'denied']),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
  refundId: z.string().nullable(),
});

export const ticketSchema = z.object({
  id: z.string(),
  orderId: z.string().nullable(),
  customerId: z.string(),
  reason: z.string(),
  summary: z.string(),
  priority: z.enum(['normal', 'high']),
  status: z.enum(['open', 'closed']),
  createdAt: z.string(),
});

export const createdRefundSchema = z.object({ refund: refundSchema, created: z.boolean() });
export const createdRefundRequestSchema = z.object({ request: refundRequestSchema, created: z.boolean() });
export const createdTicketSchema = z.object({ ticket: ticketSchema, created: z.boolean() });
