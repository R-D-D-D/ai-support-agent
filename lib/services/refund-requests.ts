import { randomBytes } from 'node:crypto';
import { getStore } from '@/lib/data/store';
import { simulatedLatency } from '@/lib/services/latency';
import type { RefundRequest } from '@/lib/types';

export async function findPendingRequestForOrder(orderId: string): Promise<RefundRequest | null> {
  await simulatedLatency();
  const request = getStore().refundRequests.find((r) => r.orderId === orderId && r.status === 'pending');
  return request ? structuredClone(request) : null;
}

export async function findLatestRequestForOrder(orderId: string): Promise<RefundRequest | null> {
  await simulatedLatency();
  const requests = getStore().refundRequests.filter((r) => r.orderId === orderId);
  return requests.length ? structuredClone(requests[requests.length - 1]) : null;
}

// Files a refund request for staff. Idempotent per order: if a pending request
// already exists for the order, it is returned instead of a new one.
export async function createRefundRequest(input: {
  orderId: string;
  customerId: string;
  amount: number;
  claim: RefundRequest['claim'];
  reviewReasons: string[];
  agentNote: string;
}): Promise<{ request: RefundRequest; created: boolean }> {
  await simulatedLatency();
  const store = getStore();
  const existing = store.refundRequests.find((r) => r.orderId === input.orderId && r.status === 'pending');
  if (existing) return { request: structuredClone(existing), created: false };

  const request: RefundRequest = {
    id: `RR-${randomBytes(3).toString('hex').toUpperCase()}`,
    ...input,
    currency: 'USD',
    status: 'pending',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    refundId: null,
  };
  store.refundRequests.push(request);
  return { request: structuredClone(request), created: true };
}
