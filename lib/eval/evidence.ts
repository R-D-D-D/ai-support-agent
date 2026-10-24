// Builds the evidence the response judge sees. Everything here comes from the
// scenario author, the seeded data, the gateway's run log, or the backend
// state difference. Text the agent wrote itself (tool arguments, ticket
// summaries, notes for staff) is labelled as agent-written so the judge never
// mistakes it for ground truth.

import type { ResponseExpectation, TrialTrace } from '@/lib/eval/types';

const MAX_JSON = 1500;

function clip(value: unknown): string {
  const text = JSON.stringify(value ?? null);
  return text.length > MAX_JSON ? `${text.slice(0, MAX_JSON)}… (truncated)` : text;
}

export interface JudgeEvidence {
  scenario: { id: string; title: string };
  signedInCustomer: string;
  conversation: { turn: number; customer: string; customerApprovalDecisions: string[]; agentReply: string }[];
  groundTruthFacts: string[];
  responseExpectations: { mustConvey: string[]; mustNot: string[] };
  toolResults: { turn: number; tool: string; agentArguments: string; succeeded: boolean; systemResult: string }[];
  verifiedBackendChanges: string[];
  // The final turn as the customer saw it, in order. Approval cards and the
  // customer's answers appear between the assistant's text segments.
  finalResponse: string;
}

// Shows a turn's reply in the order the customer saw it.
export function formatTurnReply(turn: TrialTrace['turns'][number]): string {
  if (!turn.segments?.length || turn.segments.length === 1) return turn.assistantText;
  return turn.segments
    .map((s) =>
      s.afterApproval === null
        ? `[assistant, before the approval card]\n${s.text}`
        : `[approval card shown; customer ${s.afterApproval.replace('_', ' ')}]\n[assistant, after the customer's answer]\n${s.text}`,
    )
    .join('\n');
}

export function buildJudgeEvidence(
  trace: TrialTrace,
  scenario: { id: string; title: string },
  facts: string[],
  expectations: ResponseExpectation,
  signedInCustomer = trace.customerId,
): JudgeEvidence {
  const conversation = trace.turns.map((t) => ({
    turn: t.turn,
    customer: t.user,
    customerApprovalDecisions: trace.approvalEvents
      .filter((e) => e.turn === t.turn)
      .map((e) => `${e.decision}: "${e.description}"`),
    agentReply: formatTurnReply(t),
  }));

  // Runs are in order; attribute each to the turn whose customer text it answered.
  let turn = 0;
  const toolResults = trace.runs.flatMap((run) => {
    if (!run.userMessage.startsWith('Customer approved') && !run.userMessage.startsWith('Customer declined')) turn += 1;
    return run.toolCalls.map((c) => ({
      turn,
      tool: c.tool,
      agentArguments: clip(c.input),
      succeeded: c.ok,
      systemResult: clip(c.ok ? c.output : c.error),
    }));
  });

  const changes: string[] = [];
  for (const r of trace.diff.refunds.added) {
    changes.push(`Refund ${r.id} created: order ${r.orderId}, $${r.amount.toFixed(2)}, issued by ${r.issuedBy}.`);
  }
  for (const r of trace.diff.refundRequests.added) {
    changes.push(
      `Refund request ${r.id} created for staff review: order ${r.orderId}, $${r.amount.toFixed(2)}, status ${r.status}. (Its note for staff was written by the agent.)`,
    );
  }
  for (const t of trace.diff.tickets.added) {
    changes.push(`Support ticket ${t.id} opened${t.orderId ? ` for order ${t.orderId}` : ''}. (Its summary was written by the agent.)`);
  }
  for (const e of trace.approvalEvents.filter((e) => e.decision === 'left_pending')) {
    changes.push(`An approval card for ${e.tool} is still waiting for the customer; the action has not run.`);
  }
  if (changes.length === 0) changes.push('No refund, refund request, or ticket was created.');

  const finalTurn = trace.turns.at(-1);
  return {
    scenario,
    signedInCustomer,
    conversation,
    groundTruthFacts: facts,
    responseExpectations: { mustConvey: expectations.mustConvey, mustNot: expectations.mustNot },
    toolResults,
    verifiedBackendChanges: changes,
    finalResponse: finalTurn ? formatTurnReply(finalTurn) : trace.finalResponse,
  };
}
