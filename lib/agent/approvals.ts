// Server-side record of every approval the customer is asked for.
//
// When the agent calls a tool that changes data, the customer sees an Approve
// or Decline card. The approval comes back inside the chat history, which the
// browser controls, so the server never trusts it on its own. Each request is
// recorded here when it is shown, and the tool only runs if a matching record
// exists for this customer, with the same input, unused, and under 10 minutes
// old. The AI SDK additionally signs each approval request so a forged one is
// rejected before it gets here.

import { APPROVAL_TTL_MS } from '@/lib/config';
import { getStore } from '@/lib/data/store';

export type ApprovalTool = 'issue_refund' | 'request_staff_refund' | 'escalate_to_human';

export interface ApprovalRecord {
  toolCallId: string;
  customerId: string;
  tool: ApprovalTool;
  // The validated tool input, as canonical JSON, so any change is detected.
  inputKey: string;
  // The text the customer was shown.
  description: string;
  createdAt: number;
  usedAt: number | null;
}

export type ApprovalCheck = { ok: true; record: ApprovalRecord } | { ok: false; reason: string };

// JSON with sorted keys, so the same input always gives the same string.
export function canonicalInput(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export function recordApprovalRequest(input: {
  toolCallId: string;
  customerId: string;
  tool: ApprovalTool;
  input: unknown;
  description: string;
  now?: number;
}): void {
  const approvals = getStore().approvals;
  // Never overwrite: the first record decides the expiry time.
  if (approvals[input.toolCallId]) return;
  approvals[input.toolCallId] = {
    toolCallId: input.toolCallId,
    customerId: input.customerId,
    tool: input.tool,
    inputKey: canonicalInput(input.input),
    description: input.description,
    createdAt: input.now ?? Date.now(),
    usedAt: null,
  };
}

export function checkApproval(input: {
  toolCallId: string | undefined;
  customerId: string;
  tool: ApprovalTool;
  input: unknown;
  now?: number;
}): ApprovalCheck {
  const now = input.now ?? Date.now();
  const record = input.toolCallId ? getStore().approvals[input.toolCallId] : undefined;
  if (!record || record.customerId !== input.customerId || record.tool !== input.tool) {
    return { ok: false, reason: 'No matching approval was requested from this customer.' };
  }
  if (record.usedAt !== null) {
    return { ok: false, reason: 'This approval has already been used.' };
  }
  if (now - record.createdAt > APPROVAL_TTL_MS) {
    return { ok: false, reason: 'This approval expired. Approvals are valid for 10 minutes.' };
  }
  if (record.inputKey !== canonicalInput(input.input)) {
    return { ok: false, reason: 'The action differs from what the customer approved.' };
  }
  return { ok: true, record };
}

// Marks an approval as used. Returns false if it was already used, so two
// executions racing on the same approval cannot both proceed.
export function consumeApproval(toolCallId: string, now = Date.now()): boolean {
  const record = getStore().approvals[toolCallId];
  if (!record || record.usedAt !== null) return false;
  record.usedAt = now;
  return true;
}
