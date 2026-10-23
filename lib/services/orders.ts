import { getStore } from '@/lib/data/store';
import { simulatedLatency } from '@/lib/services/latency';
import type { Order } from '@/lib/types';

export async function getOrder(orderId: string): Promise<Order | null> {
  await simulatedLatency();
  const order = getStore().orders.find((o) => o.id === orderId);
  return order ? structuredClone(order) : null;
}

export async function listOrdersForCustomer(customerId: string): Promise<Order[]> {
  await simulatedLatency();
  return structuredClone(
    getStore()
      .orders.filter((o) => o.customerId === customerId)
      .sort((a, b) => b.placedAt.localeCompare(a.placedAt)),
  );
}
