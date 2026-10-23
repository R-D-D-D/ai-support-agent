// Shared domain types for the simulated e-commerce backend.

export type ServiceName = 'orders' | 'shipments' | 'refunds' | 'tickets';

// How a simulated backend service should misbehave.
// 'flaky' fails the first attempt and succeeds on the retry.
export type FaultMode =
  | 'none'
  | 'flaky'
  | 'timeout'
  | 'server_error'
  | 'rate_limited'
  | 'malformed';

export const FAULT_MODES: FaultMode[] = [
  'none',
  'flaky',
  'timeout',
  'server_error',
  'rate_limited',
  'malformed',
];

export const SERVICE_NAMES: ServiceName[] = ['orders', 'shipments', 'refunds', 'tickets'];

export type FaultConfig = Partial<Record<ServiceName, FaultMode>>;

export interface Customer {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
}

export interface OrderItem {
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

export type OrderStatus = 'processing' | 'shipped' | 'delivered' | 'cancelled';

export interface Order {
  id: string;
  customerId: string;
  placedAt: string;
  items: OrderItem[];
  total: number;
  currency: 'USD';
  status: OrderStatus;
  shipmentId: string;
  // Staff-only notes. The gateway never returns this field to the agent.
  internalNotes: string;
}

export type ShipmentStatus =
  | 'label_created'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'exception';

export interface ShipmentEvent {
  at: string;
  location: string;
  description: string;
}

export interface Shipment {
  id: string;
  orderId: string;
  carrier: string;
  trackingNumber: string;
  status: ShipmentStatus;
  estimatedDelivery: string;
  deliveredAt: string | null;
  events: ShipmentEvent[];
  // Free text written by the carrier. Treated as untrusted data.
  carrierNote: string | null;
}

export interface Refund {
  id: string;
  orderId: string;
  customerId: string;
  amount: number;
  currency: 'USD';
  reason: string;
  createdAt: string;
  status: 'issued';
}

export interface Ticket {
  id: string;
  orderId: string | null;
  customerId: string;
  reason: string;
  summary: string;
  priority: 'normal' | 'high';
  status: 'open' | 'closed';
  createdAt: string;
}
