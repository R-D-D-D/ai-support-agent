'use client';

import { useState } from 'react';
import { cx } from '@/lib/format';

interface ToolPartLike {
  type: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; requestReason?: string; reason?: string; isAutomatic?: boolean };
}

const LABELS: Record<string, string> = {
  list_my_orders: 'Listed orders',
  get_order_details: 'Looked up order',
  get_shipment_tracking: 'Checked tracking',
  check_refund_eligibility: 'Checked refund policy',
  issue_refund: 'Refund',
  request_staff_refund: 'Refund request for staff',
  escalate_to_human: 'Support ticket',
};

// Shown in place of the normal card when the agent wants to change data and
// needs the customer's go-ahead.
function ApprovalPrompt({
  part,
  onRespond,
}: {
  part: ToolPartLike;
  onRespond?: (id: string, approved: boolean) => void;
}) {
  const name = part.type.replace(/^tool-/, '');
  const [answered, setAnswered] = useState(false);
  const respond = (approved: boolean) => {
    if (!part.approval || answered) return;
    setAnswered(true);
    onRespond?.(part.approval.id, approved);
  };
  return (
    <div className="my-2 rounded-lg border-2 border-indigo-300 bg-white px-3 py-3 text-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-indigo-700 mb-1">
        {LABELS[name] ?? name} · your approval needed
      </div>
      <p className="text-gray-900">{part.approval?.requestReason ?? 'The assistant wants to take an action.'}</p>
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => respond(true)}
          disabled={answered}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-white font-medium hover:bg-indigo-700 disabled:opacity-60"
        >
          Approve
        </button>
        <button
          onClick={() => respond(false)}
          disabled={answered}
          className="rounded-md border border-gray-300 px-3 py-1.5 hover:bg-gray-50 disabled:opacity-60"
        >
          Decline
        </button>
      </div>
    </div>
  );
}

// One card per tool call in the chat, showing what the agent called, with what
// input, and what came back.
export function ToolCard({
  part,
  onApprovalResponse,
}: {
  part: ToolPartLike;
  onApprovalResponse?: (id: string, approved: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  if (part.state === 'approval-requested' && !part.approval?.isAutomatic) {
    return <ApprovalPrompt part={part} onRespond={onApprovalResponse} />;
  }
  return <ToolSummary part={part} open={open} setOpen={setOpen} />;
}

function ToolSummary({ part, open, setOpen }: { part: ToolPartLike; open: boolean; setOpen: (fn: (o: boolean) => boolean) => void }) {
  const name = part.type.replace(/^tool-/, '');
  const output = part.output as { ok?: boolean; error?: { code: string; message: string; attempts?: number }; data?: unknown } | undefined;

  const running =
    part.state === 'input-streaming' || part.state === 'input-available' || part.state === 'approval-responded';
  const denied = part.state === 'output-denied';
  const failed = denied || part.state === 'output-error' || output?.ok === false;
  const orderId = (part.input as { orderId?: string } | undefined)?.orderId;

  let summary = running
    ? part.state === 'approval-responded'
      ? part.approval?.approved
        ? 'approved, running…'
        : 'declined'
      : 'running…'
    : denied
      ? part.approval?.isAutomatic
        ? 'not allowed'
        : part.approval?.approved
          ? 'approval not accepted'
          : 'you declined'
      : failed
        ? output?.error?.code ?? 'error'
        : 'ok';
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
          {denied && part.approval?.reason && (
            <div>
              <div className="text-gray-500">{part.approval.isAutomatic ? 'Why it was not allowed' : 'Your answer'}</div>
              <div className="text-gray-800">{part.approval.reason}</div>
            </div>
          )}
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
