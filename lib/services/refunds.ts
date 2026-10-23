import { randomBytes } from 'node:crypto';
import { getStore } from '@/lib/data/store';
import { simulatedLatency } from '@/lib/services/latency';
import type { Refund } from '@/lib/types';

export async function findRefundForOrder(orderId: string): Promise<Refund | null> {
  await simulatedLatency();
  const refund = getStore().refunds.find((r) => r.orderId === orderId);
  return refund ? structuredClone(refund) : null;
}

// Creates a refund. Idempotent per order: if a refund already exists for the
// order, it is returned unchanged and no second refund is created.
export async function createRefund(input: {
  orderId: string;
  customerId: string;
  amount: number;
  reason: string;
}): Promise<{ refund: Refund; created: boolean }> {
  await simulatedLatency();
  const store = getStore();
  const existing = store.refunds.find((r) => r.orderId === input.orderId);
  if (existing) return { refund: structuredClone(existing), created: false };

  const refund: Refund = {
    id: `RF-${randomBytes(3).toString('hex').toUpperCase()}`,
    orderId: input.orderId,
    customerId: input.customerId,
    amount: input.amount,
    currency: 'USD',
    reason: input.reason,
    createdAt: new Date().toISOString(),
    status: 'issued',
  };
  store.refunds.push(refund);
  return { refund: structuredClone(refund), created: true };
}

export async function listRefundsForCustomer(customerId: string): Promise<Refund[]> {
  await simulatedLatency();
  return structuredClone(getStore().refunds.filter((r) => r.customerId === customerId));
}
