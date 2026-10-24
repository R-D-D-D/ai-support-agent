'use client';

import { useEffect, useState } from 'react';
import type { RunRecord } from '@/lib/agent/run-log';
import { cx, formatDate, formatMoney } from '@/lib/format';
import {
  FAULT_MODES,
  SERVICE_NAMES,
  type FaultConfig,
  type FaultMode,
  type OrderItem,
  type Refund,
  type RefundRequest,
  type Shipment,
  type Ticket,
} from '@/lib/types';

interface PanelOrder {
  id: string;
  placedAt: string;
  status: string;
  total: number;
  currency: string;
  items: OrderItem[];
  shipment: Shipment | null;
  refund: Refund | null;
  refundRequests: RefundRequest[];
  tickets: Ticket[];
}

interface PanelData {
  orders: PanelOrder[];
  refunds: Refund[];
  refundRequests: RefundRequest[];
  tickets: Ticket[];
  serverTime: string;
}

type Tab = 'orders' | 'activity' | 'runs' | 'faults';

export function SidePanel(props: {
  dataVersion: number;
  onRefresh: () => void;
  faultConfig: FaultConfig;
  onFaultConfigChange: (config: FaultConfig) => void;
}) {
  const [tab, setTab] = useState<Tab>('orders');
  const [data, setData] = useState<PanelData | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [d, r] = await Promise.all([
        fetch('/api/data', { cache: 'no-store' }).then((res) => (res.ok ? res.json() : null)),
        fetch('/api/runs', { cache: 'no-store' }).then((res) => (res.ok ? res.json() : null)),
      ]);
      if (cancelled) return;
      if (d) setData(d);
      if (r) setRuns(r.runs);
    })();
    return () => {
      cancelled = true;
    };
  }, [props.dataVersion]);

  const faultCount = Object.values(props.faultConfig).filter((m) => m && m !== 'none').length;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'orders', label: 'Orders' },
    {
      id: 'activity',
      label: `Refunds & tickets${data ? ` (${data.refunds.length + data.refundRequests.length + data.tickets.length})` : ''}`,
    },
    { id: 'runs', label: `Runs (${runs.length})` },
    { id: 'faults', label: faultCount ? `Faults (${faultCount})` : 'Faults' },
  ];

  return (
    <aside className="flex flex-col min-h-0 bg-gray-50 border-t lg:border-t-0 border-gray-200">
      <div className="flex items-center gap-1 px-3 pt-3 border-b border-gray-200 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cx(
              'whitespace-nowrap px-3 py-2 text-sm rounded-t-md',
              tab === t.id ? 'bg-white border border-b-white border-gray-200 -mb-px font-medium' : 'text-gray-600 hover:text-gray-900',
            )}
          >
            {t.label}
          </button>
        ))}
        <button onClick={props.onRefresh} className="ml-auto text-xs text-gray-500 hover:text-gray-800 px-2" title="Refresh">
          ↻
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <p className="text-[11px] text-gray-400 mb-2">
          Backstage view of the simulated backend for this demo. The agent sees this data only through its tools.
        </p>
        {tab === 'orders' && <OrdersTab orders={data?.orders ?? []} />}
        {tab === 'activity' && (
          <ActivityTab refunds={data?.refunds ?? []} requests={data?.refundRequests ?? []} tickets={data?.tickets ?? []} />
        )}
        {tab === 'runs' && <RunsTab runs={runs} />}
        {tab === 'faults' && <FaultsTab config={props.faultConfig} onChange={props.onFaultConfigChange} />}
      </div>
    </aside>
  );
}

function Badge({ children, tone = 'gray' }: { children: React.ReactNode; tone?: 'gray' | 'green' | 'amber' | 'red' | 'indigo' }) {
  const tones = {
    gray: 'bg-gray-100 text-gray-700',
    green: 'bg-green-100 text-green-800',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-800',
    indigo: 'bg-indigo-100 text-indigo-800',
  };
  return <span className={cx('rounded px-1.5 py-0.5 text-[11px] font-medium', tones[tone])}>{children}</span>;
}

function shipmentTone(status: string) {
  if (status === 'delivered') return 'green';
  if (status === 'exception') return 'red';
  return 'indigo';
}

function OrdersTab({ orders }: { orders: PanelOrder[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (orders.length === 0) return <p className="text-sm text-gray-500">Loading…</p>;
  return (
    <ul className="space-y-2">
      {orders.map((o) => {
        const open = openId === o.id;
        return (
          <li key={o.id} className="rounded-lg border border-gray-200 bg-white">
            <button onClick={() => setOpenId(open ? null : o.id)} className="w-full text-left px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium">{o.id}</span>
                {o.shipment && <Badge tone={shipmentTone(o.shipment.status)}>{o.shipment.status.replace(/_/g, ' ')}</Badge>}
                {o.refund && <Badge tone="green">refunded</Badge>}
                {!o.refund && o.refundRequests.some((r) => r.status === 'pending') && <Badge tone="amber">refund requested</Badge>}
                {!o.refund && o.refundRequests.at(-1)?.status === 'denied' && <Badge tone="red">refund denied</Badge>}
                {o.tickets.some((t) => t.status === 'open') && <Badge tone="amber">ticket open</Badge>}
                <span className="ml-auto text-sm">{formatMoney(o.total)}</span>
              </div>
              <div className="text-xs text-gray-500 mt-0.5 truncate">
                {o.items.map((i) => `${i.name} ×${i.quantity}`).join(', ')}
              </div>
              {o.shipment && (
                <div className="text-xs text-gray-500">
                  {o.shipment.deliveredAt
                    ? `Delivered ${formatDate(o.shipment.deliveredAt)}`
                    : `Est. delivery ${formatDate(o.shipment.estimatedDelivery)}`}
                </div>
              )}
            </button>
            {open && (
              <div className="border-t border-gray-100 px-3 py-2 text-xs space-y-2">
                <div className="text-gray-600">Placed {formatDate(o.placedAt)} · order status {o.status}</div>
                <table className="w-full">
                  <tbody>
                    {o.items.map((i) => (
                      <tr key={i.sku}>
                        <td className="py-0.5">{i.name}</td>
                        <td className="text-right text-gray-500">×{i.quantity}</td>
                        <td className="text-right">{formatMoney(i.unitPrice)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {o.shipment && (
                  <div>
                    <div className="font-medium text-gray-700">
                      {o.shipment.carrier} · <span className="font-mono">{o.shipment.trackingNumber}</span>
                    </div>
                    <ol className="mt-1 space-y-0.5 border-l border-gray-200 pl-2">
                      {[...o.shipment.events].reverse().map((e, idx) => (
                        <li key={idx}>
                          <span className="text-gray-500">{formatDate(e.at)}</span> · {e.description}{' '}
                          <span className="text-gray-400">({e.location})</span>
                        </li>
                      ))}
                    </ol>
                    {o.shipment.carrierNote && (
                      <div className="mt-1 rounded bg-yellow-50 border border-yellow-200 px-2 py-1 text-yellow-900">
                        <span className="font-medium">Carrier note:</span> {o.shipment.carrierNote}
                      </div>
                    )}
                  </div>
                )}
                {o.refund && (
                  <div className="text-green-800">
                    Refund {o.refund.id}: {formatMoney(o.refund.amount)} on {formatDate(o.refund.createdAt)}
                  </div>
                )}
                {o.tickets.map((t) => (
                  <div key={t.id} className="text-amber-800">
                    Ticket {t.id} ({t.status}, {t.priority}): {t.reason.replace(/_/g, ' ')}
                  </div>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ActivityTab({ refunds, requests, tickets }: { refunds: Refund[]; requests: RefundRequest[]; tickets: Ticket[] }) {
  return (
    <div className="space-y-4 text-sm">
      <section>
        <h3 className="font-medium mb-1">Refund requests for staff</h3>
        {requests.length === 0 && <p className="text-gray-500 text-xs">None yet.</p>}
        <ul className="space-y-1">
          {[...requests].reverse().map((r) => (
            <li key={r.id} className="rounded border border-gray-200 bg-white px-3 py-2">
              <div className="flex gap-2 items-center">
                <span className="font-mono">{r.id}</span>
                <span className="font-mono text-gray-500">{r.orderId}</span>
                <Badge tone={r.status === 'approved' ? 'green' : r.status === 'denied' ? 'red' : 'amber'}>{r.status}</Badge>
                <span className="ml-auto">{formatMoney(r.amount)}</span>
              </div>
              <div className="text-xs text-gray-500">{r.reviewReasons.join(' ')}</div>
              {r.decisionNote && <div className="text-xs text-gray-700">Staff note: {r.decisionNote}</div>}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3 className="font-medium mb-1">Refunds</h3>
        {refunds.length === 0 && <p className="text-gray-500 text-xs">None yet.</p>}
        <ul className="space-y-1">
          {[...refunds].reverse().map((r) => (
            <li key={r.id} className="rounded border border-gray-200 bg-white px-3 py-2">
              <div className="flex gap-2">
                <span className="font-mono">{r.id}</span>
                <span className="font-mono text-gray-500">{r.orderId}</span>
                <span className="ml-auto">{formatMoney(r.amount)}</span>
              </div>
              <div className="text-xs text-gray-500">
                {formatDate(r.createdAt)} · {r.issuedBy === 'bot' ? 'issued by the assistant' : 'approved by staff'} · {r.reason}
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3 className="font-medium mb-1">Tickets for human agents</h3>
        {tickets.length === 0 && <p className="text-gray-500 text-xs">None yet.</p>}
        <ul className="space-y-1">
          {[...tickets].reverse().map((t) => (
            <li key={t.id} className="rounded border border-gray-200 bg-white px-3 py-2">
              <div className="flex gap-2 items-center">
                <span className="font-mono">{t.id}</span>
                {t.orderId && <span className="font-mono text-gray-500">{t.orderId}</span>}
                <Badge tone={t.priority === 'high' ? 'red' : 'amber'}>{t.priority}</Badge>
                <span className="ml-auto text-xs text-gray-500">{t.reason.replace(/_/g, ' ')}</span>
              </div>
              <div className="text-xs text-gray-600 whitespace-pre-wrap mt-1">{t.summary}</div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function RunsTab({ runs }: { runs: RunRecord[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (runs.length === 0) return <p className="text-sm text-gray-500">No agent runs yet.</p>;
  return (
    <ul className="space-y-2 text-xs">
      {runs.map((r) => {
        const open = openId === r.runId;
        const failures = r.toolCalls.filter((c) => !c.ok).length;
        const faults = Object.entries(r.faultConfig).filter(([, m]) => m && m !== 'none');
        return (
          <li key={r.runId} className="rounded-lg border border-gray-200 bg-white">
            <button onClick={() => setOpenId(open ? null : r.runId)} className="w-full text-left px-3 py-2">
              <div className="flex items-center gap-2">
                <Badge tone={r.status === 'completed' ? 'green' : r.status === 'running' ? 'indigo' : 'red'}>{r.status}</Badge>
                <span className="text-gray-500">{formatDate(r.startedAt)}</span>
                <span className="ml-auto text-gray-500">
                  {r.toolCalls.length} tool calls{failures ? `, ${failures} failed` : ''} · {r.steps} steps
                </span>
              </div>
              <div className="mt-1 truncate text-gray-800">“{r.userMessage}”</div>
              {faults.length > 0 && <div className="text-amber-700">Faults: {faults.map(([s, m]) => `${s}=${m}`).join(', ')}</div>}
            </button>
            {open && (
              <div className="border-t border-gray-100 px-3 py-2 space-y-2">
                <div className="text-gray-500 font-mono">run {r.runId}</div>
                {r.toolCalls.map((c, i) => (
                  <div key={i} className={cx('rounded border px-2 py-1', c.ok ? 'border-gray-200' : 'border-amber-300 bg-amber-50')}>
                    <div className="flex gap-2">
                      <span className="font-mono font-medium">{c.tool}</span>
                      <span className="text-gray-500">{c.durationMs} ms</span>
                      <span className="ml-auto">{c.ok ? 'ok' : c.error?.code}</span>
                    </div>
                    <div className="text-gray-500">
                      Backend calls:{' '}
                      {c.serviceCalls.length === 0
                        ? 'none'
                        : c.serviceCalls
                            .map((s) => `${s.service} ${s.ok ? 'ok' : s.errorCode}${s.attempts > 1 ? ` (${s.attempts} attempts)` : ''}`)
                            .join(', ')}
                    </div>
                    <details>
                      <summary className="cursor-pointer text-gray-500">Input and result</summary>
                      <pre className="whitespace-pre-wrap break-all font-mono text-[11px]">
                        {JSON.stringify({ input: c.input, result: c.ok ? c.output : c.error }, null, 2)}
                      </pre>
                    </details>
                  </div>
                ))}
                {r.finalText && (
                  <div>
                    <div className="text-gray-500">Final reply</div>
                    <div className="whitespace-pre-wrap">{r.finalText}</div>
                  </div>
                )}
                <div className="text-gray-500">
                  Tokens: {r.usage.inputTokens} in / {r.usage.outputTokens} out · finish: {r.finishReason ?? '—'}
                  {r.error && <span className="text-red-700"> · error: {r.error}</span>}
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const FAULT_HELP: Record<FaultMode, string> = {
  none: 'Normal',
  flaky: 'Fails first try, retry succeeds',
  timeout: 'Hangs; gateway times out after 3s',
  server_error: 'HTTP 500 every time',
  rate_limited: 'HTTP 429 every time',
  malformed: 'Returns garbage data',
};

function FaultsTab({ config, onChange }: { config: FaultConfig; onChange: (c: FaultConfig) => void }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-gray-600">
        Make a simulated backend service misbehave. Applies to the next message you send. The gateway retries
        temporary failures once, then reports the error to the agent.
      </p>
      {SERVICE_NAMES.map((service) => (
        <label key={service} className="flex items-center gap-3">
          <span className="w-20 font-medium capitalize">{service}</span>
          <select
            value={config[service] ?? 'none'}
            onChange={(e) => onChange({ ...config, [service]: e.target.value as FaultMode })}
            className="flex-1 rounded-md border border-gray-300 bg-white px-2 py-1"
          >
            {FAULT_MODES.map((m) => (
              <option key={m} value={m}>
                {m} · {FAULT_HELP[m]}
              </option>
            ))}
          </select>
        </label>
      ))}
      <button onClick={() => onChange({})} className="rounded-md border border-gray-300 px-3 py-1.5 text-xs hover:bg-white">
        Clear all faults
      </button>
    </div>
  );
}
