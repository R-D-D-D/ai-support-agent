'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { cx, formatDate, formatMoney } from '@/lib/format';
import type { StaffRequestView } from '@/lib/staff/decide';

export function StaffQueue({ staff }: { staff: { name: string; email: string } }) {
  const router = useRouter();
  const [requests, setRequests] = useState<StaffRequestView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/staff/requests', { cache: 'no-store' });
    if (res.ok) setRequests((await res.json()).requests);
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  async function decide(id: string, approved: boolean, note: string) {
    setError(null);
    const res = await fetch(`/api/staff/requests/${encodeURIComponent(id)}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved, note: note || undefined }),
    });
    if (!res.ok) setError((await res.json().catch(() => ({}))).message ?? 'The decision failed.');
    await load();
  }

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }

  const pending = requests?.filter((r) => r.status === 'pending') ?? [];
  const decided = requests?.filter((r) => r.status !== 'pending') ?? [];

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-gray-200 bg-white">
        <div>
          <h1 className="font-semibold">ShopCo Support · Staff</h1>
          <p className="text-xs text-gray-500">Refund requests the assistant was not allowed to grant</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="hidden sm:inline text-gray-600">{staff.name}</span>
          <button onClick={signOut} className="rounded-md border border-gray-300 px-3 py-1.5 hover:bg-gray-50">
            Sign out
          </button>
        </div>
      </header>
      <main className="max-w-3xl mx-auto p-4 sm:p-6 space-y-6">
        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <section>
          <h2 className="font-medium mb-2">Waiting for a decision ({pending.length})</h2>
          {requests === null && <p className="text-sm text-gray-500">Loading…</p>}
          {requests !== null && pending.length === 0 && <p className="text-sm text-gray-500">Nothing waiting.</p>}
          <ul className="space-y-3">
            {pending.map((r) => (
              <RequestCard key={r.id} request={r} onDecide={decide} />
            ))}
          </ul>
        </section>
        {decided.length > 0 && (
          <section>
            <h2 className="font-medium mb-2">Decided</h2>
            <ul className="space-y-2">
              {decided.map((r) => (
                <li key={r.id} className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm flex flex-wrap gap-x-3">
                  <span className="font-mono">{r.id}</span>
                  <span className="font-mono text-gray-500">{r.orderId}</span>
                  <span>{formatMoney(r.amount)}</span>
                  <span className={r.status === 'approved' ? 'text-green-700' : 'text-red-700'}>{r.status}</span>
                  <span className="text-gray-500">
                    by {r.decidedByName} · {formatDate(r.decidedAt)}
                    {r.refundId ? ` · refund ${r.refundId}` : ''}
                  </span>
                  {r.decisionNote && <span className="w-full text-gray-600">Note to customer: {r.decisionNote}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}

function RequestCard({
  request: r,
  onDecide,
}: {
  request: StaffRequestView;
  onDecide: (id: string, approved: boolean, note: string) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function click(approved: boolean) {
    setBusy(true);
    await onDecide(r.id, approved, note);
    setBusy(false);
  }

  return (
    <li className="rounded-lg border border-gray-200 bg-white p-4 text-sm space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-medium">{r.id}</span>
        <span className="font-mono text-gray-500">{r.orderId}</span>
        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">{r.claim}</span>
        <span className="ml-auto text-base font-medium">{formatMoney(r.amount)}</span>
      </div>
      <div className="grid sm:grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-gray-500">Customer</div>
          <div>{r.customer?.name} · {r.customer?.email}</div>
          <div className="text-gray-500 mt-2">Order</div>
          <div>{r.order?.items}</div>
          <div>Placed {formatDate(r.order?.placedAt)} · payment {r.order?.paymentStatus}</div>
          {r.order?.riskFlag && <div className="text-red-700 font-medium">Risk flag set</div>}
          {r.order?.internalNotes && <div className="text-gray-600">Internal note: {r.order.internalNotes}</div>}
        </div>
        <div>
          <div className="text-gray-500">Shipment ({r.shipment?.carrier})</div>
          <div>Status {r.shipment?.status.replace(/_/g, ' ')}</div>
          <div>Estimated {formatDate(r.shipment?.estimatedDelivery)}</div>
          {r.shipment?.deliveredAt && <div>Delivered {formatDate(r.shipment.deliveredAt)}</div>}
          <div>Last scan {formatDate(r.shipment?.lastScan)}</div>
          {r.shipment?.carrierNote && (
            <div className="mt-1 rounded bg-yellow-50 border border-yellow-200 px-2 py-1">
              Carrier note (third-party text): {r.shipment.carrierNote}
            </div>
          )}
        </div>
      </div>
      <div className="text-xs">
        <div className="text-gray-500">Why the assistant could not refund it</div>
        <ul className="list-disc pl-5">
          {r.reviewReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </div>
      <div className="text-xs rounded border border-gray-200 bg-gray-50 px-2 py-1">
        <span className="text-gray-500">Assistant&apos;s note (written by the AI from the conversation; verify claims against the facts above):</span>{' '}
        {r.agentNote}
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          placeholder="Optional note, shown to the customer"
          className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        />
        <button
          disabled={busy}
          onClick={() => click(true)}
          className={cx('rounded-md bg-green-600 px-3 py-1.5 text-white font-medium hover:bg-green-700', busy && 'opacity-60')}
        >
          Approve refund
        </button>
        <button
          disabled={busy}
          onClick={() => click(false)}
          className={cx('rounded-md border border-gray-300 px-3 py-1.5 hover:bg-gray-50', busy && 'opacity-60')}
        >
          Deny
        </button>
      </div>
    </li>
  );
}
