'use client';

import { useState } from 'react';
import { cx } from '@/lib/format';

interface ToolPartLike {
  type: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

const LABELS: Record<string, string> = {
  list_my_orders: 'Listed orders',
  get_order_details: 'Looked up order',
  get_shipment_tracking: 'Checked tracking',
  check_refund_eligibility: 'Checked refund policy',
  issue_refund: 'Issued refund',
  escalate_to_human: 'Escalated to a human',
};

// One card per tool call in the chat, showing what the agent called, with what
// input, and what came back.
export function ToolCard({ part }: { part: ToolPartLike }) {
  const [open, setOpen] = useState(false);
  const name = part.type.replace(/^tool-/, '');
  const output = part.output as { ok?: boolean; error?: { code: string; message: string; attempts?: number }; data?: unknown } | undefined;

  const running = part.state === 'input-streaming' || part.state === 'input-available';
  const failed = part.state === 'output-error' || output?.ok === false;
  const orderId = (part.input as { orderId?: string } | undefined)?.orderId;

  let summary = running ? 'running…' : failed ? output?.error?.code ?? 'error' : 'ok';
  if (!running && name === 'check_refund_eligibility' && output?.ok) {
    summary = String((output.data as { action?: string }).action);
  }
  if (!running && failed && output?.error?.attempts && output.error.attempts > 1) {
    summary += ` after ${output.error.attempts} attempts`;
  }

  return (
    <div
      className={cx(
        'my-2 rounded-lg border text-xs',
        running && 'border-indigo-200 bg-indigo-50',
        !running && failed && 'border-amber-300 bg-amber-50',
        !running && !failed && 'border-gray-200 bg-gray-50',
      )}
    >
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-3 py-2 text-left">
        <span className="font-mono text-gray-500">{open ? '▾' : '▸'}</span>
        <span className="font-medium text-gray-800">{LABELS[name] ?? name}</span>
        {orderId && <span className="font-mono text-gray-500">{orderId}</span>}
        <span
          className={cx(
            'ml-auto rounded px-1.5 py-0.5 font-mono',
            running && 'text-indigo-700',
            !running && failed && 'bg-amber-200 text-amber-900',
            !running && !failed && 'bg-green-100 text-green-800',
          )}
        >
          {summary}
        </span>
      </button>
      {open && (
        <div className="border-t border-gray-200 px-3 py-2 space-y-2">
          <div>
            <div className="text-gray-500 mb-1">Tool: <span className="font-mono">{name}</span></div>
            <div className="text-gray-500">Input</div>
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-gray-800">{JSON.stringify(part.input, null, 2)}</pre>
          </div>
          {(part.output !== undefined || part.errorText) && (
            <div>
              <div className="text-gray-500">Result</div>
              <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-gray-800 max-h-72 overflow-auto">
                {part.errorText ?? JSON.stringify(part.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
