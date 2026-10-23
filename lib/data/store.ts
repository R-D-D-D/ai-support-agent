// In-memory data store for the simulated backend.
//
// The store lives on globalThis so that Next.js hot reloads in development do
// not wipe it. It is per server process and resets when the server restarts
// (see "Known limits" in the README).

import { buildSeed, type SeedData } from '@/lib/data/seed';
import type { RunRecord } from '@/lib/agent/run-log';

export interface Store extends SeedData {
  runs: RunRecord[];
}

const globalForStore = globalThis as unknown as { __supportStore?: Store };

export function getStore(): Store {
  globalForStore.__supportStore ??= { ...buildSeed(), runs: [] };
  return globalForStore.__supportStore;
}

// Replace all data with a fresh seed. Used by tests.
export function resetStore(now: Date = new Date()): Store {
  globalForStore.__supportStore = { ...buildSeed(now), runs: [] };
  return globalForStore.__supportStore;
}

// Restore one customer's orders, shipments, refunds, tickets, and runs to the
// seed state, leaving other customers untouched. Used by the demo reset button.
export function resetCustomer(customerId: string, now: Date = new Date()): void {
  const store = getStore();
  const seed = buildSeed(now);
  const seedOrders = seed.orders.filter((o) => o.customerId === customerId);
  const seedOrderIds = new Set(seedOrders.map((o) => o.id));

  store.orders = [...store.orders.filter((o) => o.customerId !== customerId), ...seedOrders];
  store.shipments = [
    ...store.shipments.filter((s) => !seedOrderIds.has(s.orderId)),
    ...seed.shipments.filter((s) => seedOrderIds.has(s.orderId)),
  ];
  store.refunds = [
    ...store.refunds.filter((r) => r.customerId !== customerId),
    ...seed.refunds.filter((r) => r.customerId === customerId),
  ];
  store.tickets = [
    ...store.tickets.filter((t) => t.customerId !== customerId),
    ...seed.tickets.filter((t) => t.customerId === customerId),
  ];
  store.runs = store.runs.filter((r) => r.customerId !== customerId);
}
