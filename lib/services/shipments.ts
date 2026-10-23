import { getStore } from '@/lib/data/store';
import { simulatedLatency } from '@/lib/services/latency';
import type { Shipment } from '@/lib/types';

export async function getShipmentForOrder(orderId: string): Promise<Shipment | null> {
  await simulatedLatency();
  const shipment = getStore().shipments.find((s) => s.orderId === orderId);
  return shipment ? structuredClone(shipment) : null;
}
