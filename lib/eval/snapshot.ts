// Copies the business records from the store and compares two copies, so
// grading is based on what actually changed rather than on what the agent or
// the tool log says happened. Records are matched by id, so records that
// existed before the trial are never counted as new.

import type { Store } from '@/lib/data/store';
import type { BusinessSnapshot, CollectionDiff, StateDiff } from '@/lib/eval/types';

export function takeSnapshot(store: Store): BusinessSnapshot {
  return structuredClone({
    refunds: store.refunds,
    refundRequests: store.refundRequests,
    tickets: store.tickets,
    approvals: Object.values(store.approvals),
  });
}

function diffById<T>(before: T[], after: T[], idOf: (item: T) => string): CollectionDiff<T> {
  const beforeById = new Map(before.map((item) => [idOf(item), item]));
  const afterById = new Map(after.map((item) => [idOf(item), item]));
  const diff: CollectionDiff<T> = { added: [], removed: [], changed: [] };
  for (const [id, item] of afterById) {
    const old = beforeById.get(id);
    if (!old) {
      diff.added.push(item);
      continue;
    }
    const fields = Object.keys({ ...old, ...item }).filter(
      (key) => JSON.stringify((old as Record<string, unknown>)[key]) !== JSON.stringify((item as Record<string, unknown>)[key]),
    );
    if (fields.length) diff.changed.push({ id, before: old, after: item, fields });
  }
  for (const [id, item] of beforeById) if (!afterById.has(id)) diff.removed.push(item);
  return diff;
}

export function diffSnapshots(before: BusinessSnapshot, after: BusinessSnapshot): StateDiff {
  return {
    refunds: diffById(before.refunds, after.refunds, (r) => r.id),
    refundRequests: diffById(before.refundRequests, after.refundRequests, (r) => r.id),
    tickets: diffById(before.tickets, after.tickets, (t) => t.id),
    approvals: diffById(before.approvals, after.approvals, (a) => a.toolCallId),
  };
}

// The order id inside an approval record's input, if it has one.
export function approvalOrderId(inputKey: string): string | null {
  try {
    const input = JSON.parse(inputKey) as { orderId?: unknown };
    return typeof input.orderId === 'string' ? input.orderId : null;
  } catch {
    return null;
  }
}
