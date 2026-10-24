import { randomBytes } from 'node:crypto';
import { getStore } from '@/lib/data/store';
import { simulatedLatency } from '@/lib/services/latency';
import type { Ticket } from '@/lib/types';

export async function findOpenTicketForOrder(orderId: string): Promise<Ticket | null> {
  await simulatedLatency();
  const ticket = getStore().tickets.find((t) => t.orderId === orderId && t.status === 'open');
  return ticket ? structuredClone(ticket) : null;
}

// Opens a ticket for a human agent. Idempotent per order: if the order already
// has an open ticket, that ticket is returned instead of a new one.
export async function createTicket(input: {
  orderId: string | null;
  customerId: string;
  reason: string;
  summary: string;
  priority: Ticket['priority'];
}): Promise<{ ticket: Ticket; created: boolean }> {
  await simulatedLatency();
  const store = getStore();
  if (input.orderId) {
    const existing = store.tickets.find(
      (t) => t.orderId === input.orderId && t.status === 'open',
    );
    if (existing) return { ticket: structuredClone(existing), created: false };
  }
  const ticket: Ticket = {
    id: `TCK-${randomBytes(3).toString('hex').toUpperCase()}`,
    ...input,
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  store.tickets.push(ticket);
  return { ticket: structuredClone(ticket), created: true };
}

export async function listTicketsForCustomer(customerId: string): Promise<Ticket[]> {
  await simulatedLatency();
  return structuredClone(getStore().tickets.filter((t) => t.customerId === customerId));
}

// How many tickets a customer opened in the 24 hours before `now`.
export function ticketsOpenedInLastDay(customerId: string, now: Date = new Date()): number {
  const since = now.getTime() - 24 * 60 * 60 * 1000;
  return getStore().tickets.filter(
    (t) => t.customerId === customerId && new Date(t.createdAt).getTime() > since,
  ).length;
}
