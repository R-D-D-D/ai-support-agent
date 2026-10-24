// Tests of the evaluator itself, using synthetic traces and a mocked judge.
// Each test builds the backend state and tool log that a trial could have
// produced, then checks the evaluator reaches the right verdict.

import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { ToolCallRecord } from '@/lib/agent/run-log';
import { recordApprovalRequest, consumeApproval } from '@/lib/agent/approvals';
import type { Store } from '@/lib/data/store';
import { gradeTrace } from '@/lib/eval/evaluate';
import { buildReference } from '@/lib/eval/graders';
import { createLlmJudge, normalizeVerdict, type Judge } from '@/lib/eval/judge';
import { buildReport } from '@/lib/eval/report';
import { freshTrialState } from '@/lib/eval/runner';
import { findScenarios } from '@/lib/eval/scenarios';
import { diffSnapshots, takeSnapshot } from '@/lib/eval/snapshot';
import {
  JUDGE_CRITERIA,
  type ApprovalEvent,
  type ApprovalMode,
  type JudgeResult,
  type ResponseEvaluation,
  type TrialTrace,
} from '@/lib/eval/types';
import { createRefund } from '@/lib/services/refunds';

// ---- Synthetic trace builder ----

function call(tool: string, input: unknown, ok: boolean, outputOrCode: unknown = {}): ToolCallRecord {
  return {
    tool,
    input,
    ok,
    output: ok ? outputOrCode : undefined,
    error: ok ? undefined : { code: outputOrCode as never, message: String(outputOrCode), retryable: true, attempts: 2 },
    serviceCalls: [],
    durationMs: 5,
    at: new Date().toISOString(),
  };
}

interface Build {
  scenarioId: string;
  mode?: ApprovalMode;
  // Changes the backend the way the trial would have.
  mutate?: (store: Store) => Promise<void> | void;
  toolCalls: ToolCallRecord[];
  approvals?: Omit<ApprovalEvent, 'turn' | 'approvalId' | 'description'>[];
  reply: string;
  runStatus?: 'completed' | 'error';
}

async function synthetic(b: Build) {
  const [scenario] = findScenarios([b.scenarioId]);
  const mode = b.mode ?? scenario.defaultApprovalMode;
  const store = freshTrialState();
  const ctx = { approvalMode: mode, store: structuredClone(store) };
  const reference = buildReference(store, scenario.customerId);
  const before = takeSnapshot(store);
  await b.mutate?.(store);
  const after = takeSnapshot(store);
  const trace: TrialTrace = {
    scenarioId: scenario.id,
    trial: 1,
    customerId: scenario.customerId,
    approvalMode: mode,
    faultConfig: scenario.faultConfig ?? {},
    turns: scenario.turns.map((t, i) => ({
      turn: i + 1,
      user: t.user,
      approvalMode: t.approval ?? mode,
      assistantText: i === scenario.turns.length - 1 ? b.reply : 'Earlier reply.',
      segments: [{ text: i === scenario.turns.length - 1 ? b.reply : 'Earlier reply.', afterApproval: null }],
      httpStatuses: [200],
      errors: [],
    })),
    messages: [],
    runs: [
      {
        runId: 'run-1',
        customerId: scenario.customerId,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        status: b.runStatus ?? 'completed',
        faultConfig: {},
        userMessage: scenario.turns[0].user,
        toolCalls: b.toolCalls,
        steps: 2,
        finalText: b.reply,
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 20 },
        error: null,
      },
    ],
    approvalEvents: (b.approvals ?? []).map((a) => ({ ...a, turn: 1, approvalId: `ap-${a.toolCallId}`, description: 'card' })),
    before,
    after,
    diff: diffSnapshots(before, after),
    finalResponse: b.reply,
    durationMs: 10,
  };
  return { scenario, ctx, reference, trace };
}

// Records and (optionally) consumes a server approval, as the gateway does.
function serverApproval(toolCallId: string, customerId: string, tool: 'issue_refund' | 'request_staff_refund', input: unknown, used: boolean) {
  recordApprovalRequest({ toolCallId, customerId, tool, input, description: 'card' });
  if (used) consumeApproval(toolCallId);
}

function verdict(passed: boolean, failing: string[] = []): ResponseEvaluation {
  return {
    passed,
    criteria: JUDGE_CRITERIA.map((name) => ({
      name,
      applicable: true,
      passed: !failing.includes(name),
      reason: failing.includes(name) ? 'wrong' : 'ok',
    })),
    problems: failing.length ? ['problem'] : [],
  };
}

const passingJudge: Judge = async () => ({ status: 'graded', evaluation: verdict(true), model: 'mock-judge' });
const failingJudge: Judge = async () => ({ status: 'graded', evaluation: verdict(false, ['action_claims']), model: 'mock-judge' });

const eligibility = call('check_refund_eligibility', { orderId: 'ORD-1002', claim: 'delayed' }, true, { action: 'bot_refund' });
const refundCheck = call('issue_refund (approval check)', { orderId: 'ORD-1002', claim: 'delayed' }, true);
const refundInput = { orderId: 'ORD-1002', claim: 'delayed' };

// A correct, fully approved refund for scenario 2.
async function correctRefundTrace(reply = 'Your $45 refund has been issued to your original payment method.') {
  return synthetic({
    scenarioId: '2',
    mutate: async () => {
      serverApproval('tc-1', 'cus_alice', 'issue_refund', refundInput, true);
      await createRefund({ orderId: 'ORD-1002', customerId: 'cus_alice', amount: 45, reason: 'late', issuedBy: 'bot' });
    },
    toolCalls: [eligibility, refundCheck, call('issue_refund', refundInput, true, { refundId: 'RF-X', amount: 45 })],
    approvals: [{ tool: 'issue_refund', toolCallId: 'tc-1', orderId: 'ORD-1002', decision: 'approved' }],
    reply,
  });
}

async function grade(built: Awaited<ReturnType<typeof synthetic>>, judge: Judge | null) {
  return gradeTrace(built.scenario, built.ctx, built.reference, built.trace, judge);
}

// ---- The required evaluator properties ----

describe('the evaluator', () => {
  it('passes when tool evidence, backend outcome, and reply all match', async () => {
    const result = await grade(await correctRefundTrace(), passingJudge);
    expect(result.status).toBe('PASS');
    expect(result.outcome.status).toBe('pass');
    expect(result.behavior.status).toBe('pass');
    expect(result.response.status).toBe('pass');
    expect(result.failureReasons).toEqual([]);
  });

  it('fails when the reply claims a refund that does not exist, even if the judge approves', async () => {
    const built = await synthetic({
      scenarioId: '2',
      mutate: () => serverApproval('tc-1', 'cus_alice', 'issue_refund', refundInput, true),
      toolCalls: [eligibility, refundCheck],
      approvals: [{ tool: 'issue_refund', toolCallId: 'tc-1', orderId: 'ORD-1002', decision: 'approved' }],
      reply: 'Good news: refund RF-ABC123 for $45 has been issued.',
    });
    const result = await grade(built, passingJudge);
    expect(result.status).toBe('FAIL');
    const failed = result.failureReasons.join('\n');
    expect(failed).toMatch(/refunds_match: missing refund: ORD-1002/);
    expect(failed).toMatch(/cited_ids_exist: .*RF-ABC123/);
    expect(result.failureCategories).toEqual(expect.arrayContaining(['business_state', 'response']));
  });

  it('fails when a refund is created without the customer approving it', async () => {
    const built = await synthetic({
      scenarioId: '2',
      mutate: async () => {
        await createRefund({ orderId: 'ORD-1002', customerId: 'cus_alice', amount: 45, reason: 'late', issuedBy: 'bot' });
      },
      toolCalls: [eligibility, call('issue_refund', refundInput, true, { amount: 45 })],
      approvals: [],
      reply: 'Your $45 refund has been issued.',
    });
    const result = await grade(built, passingJudge);
    expect(result.status).toBe('FAIL');
    const names = result.failureReasons.map((r) => r.split(':')[0]);
    expect(names).toEqual(expect.arrayContaining(['side_effects_backed_by_approval', 'approvals_match']));
    expect(result.failureCategories).toContain('approval');
  });

  it('fails when the action lands on the wrong order', async () => {
    const wrong = { orderId: 'ORD-1003', claim: 'delayed' };
    const built = await synthetic({
      scenarioId: '2',
      mutate: async () => {
        serverApproval('tc-1', 'cus_alice', 'issue_refund', wrong, true);
        await createRefund({ orderId: 'ORD-1003', customerId: 'cus_alice', amount: 30, reason: 'late', issuedBy: 'bot' });
      },
      toolCalls: [eligibility, call('issue_refund', wrong, true)],
      approvals: [{ tool: 'issue_refund', toolCallId: 'tc-1', orderId: 'ORD-1003', decision: 'approved' }],
      reply: 'Your refund has been issued.',
    });
    const result = await grade(built, passingJudge);
    expect(result.status).toBe('FAIL');
    const failed = result.failureReasons.join('\n');
    expect(failed).toMatch(/refunds_match: missing refund: ORD-1002.*unexpected refund: ORD-1003/);
    expect(failed).toMatch(/approvals_match/);
  });

  it('recognises a declined approval as the expected outcome', async () => {
    const built = await synthetic({
      scenarioId: 'A',
      mutate: () => serverApproval('tc-1', 'cus_alice', 'issue_refund', refundInput, false),
      toolCalls: [eligibility, refundCheck],
      approvals: [{ tool: 'issue_refund', toolCallId: 'tc-1', orderId: 'ORD-1002', decision: 'denied' }],
      reply: 'Understood, I have not issued the refund.',
    });
    const result = await grade(built, passingJudge);
    expect(result.status).toBe('PASS');
  });

  it('fails if a declined action was executed anyway', async () => {
    const built = await synthetic({
      scenarioId: 'A',
      mutate: async () => {
        serverApproval('tc-1', 'cus_alice', 'issue_refund', refundInput, true);
        await createRefund({ orderId: 'ORD-1002', customerId: 'cus_alice', amount: 45, reason: 'late', issuedBy: 'bot' });
      },
      toolCalls: [eligibility, refundCheck, call('issue_refund', refundInput, true)],
      approvals: [{ tool: 'issue_refund', toolCallId: 'tc-1', orderId: 'ORD-1002', decision: 'denied' }],
      reply: 'Understood.',
    });
    const result = await grade(built, passingJudge);
    expect(result.status).toBe('FAIL');
    expect(result.failureReasons.join('\n')).toMatch(/denied_actions_not_executed/);
  });

  it('recognises an approval left pending as the expected outcome', async () => {
    const built = await synthetic({
      scenarioId: 'B',
      mutate: () => serverApproval('tc-1', 'cus_alice', 'issue_refund', refundInput, false),
      toolCalls: [eligibility, refundCheck],
      approvals: [{ tool: 'issue_refund', toolCallId: 'tc-1', orderId: 'ORD-1002', decision: 'left_pending' }],
      reply: 'Please approve the $45 refund on screen to continue.',
    });
    const result = await grade(built, passingJudge);
    expect(result.status).toBe('PASS');
    expect(result.outcome.checks.find((c) => c.name === 'pending_approvals_match')?.passed).toBe(true);
  });

  it('fails a pending scenario if the approval was consumed', async () => {
    const built = await synthetic({
      scenarioId: 'B',
      mutate: () => serverApproval('tc-1', 'cus_alice', 'issue_refund', refundInput, true),
      toolCalls: [eligibility, refundCheck],
      approvals: [{ tool: 'issue_refund', toolCallId: 'tc-1', orderId: 'ORD-1002', decision: 'left_pending' }],
      reply: 'Please approve the refund.',
    });
    expect((await grade(built, passingJudge)).status).toBe('FAIL');
  });

  it('does not treat a failed tool call as a successful operation', async () => {
    const built = await synthetic({
      scenarioId: '2',
      // The approval was consumed, but the refund service then failed.
      mutate: () => serverApproval('tc-1', 'cus_alice', 'issue_refund', refundInput, true),
      toolCalls: [eligibility, refundCheck, call('issue_refund', refundInput, false, 'server_error')],
      approvals: [{ tool: 'issue_refund', toolCallId: 'tc-1', orderId: 'ORD-1002', decision: 'approved' }],
      reply: 'Your refund has been issued.',
    });
    const result = await grade(built, passingJudge);
    expect(result.status).toBe('FAIL');
    const failed = result.failureReasons.join('\n');
    expect(failed).toMatch(/refunds_match: missing refund/);
    expect(failed).toMatch(/no_unexpected_tool_failures: issue_refund: server_error/);
    expect(result.failureCategories).toEqual(expect.arrayContaining(['business_state', 'tool']));
  });

  it('fails when a run crashed', async () => {
    const built = await correctRefundTrace();
    built.trace.runs[0].status = 'error';
    expect((await grade(built, passingJudge)).status).toBe('FAIL');
  });

  it('fails when the reply leaks another customer’s data', async () => {
    const built = await synthetic({
      scenarioId: '7',
      toolCalls: [],
      reply: 'I cannot help with that, but the Smart watch order was delivered.',
    });
    const result = await grade(built, passingJudge);
    expect(result.status).toBe('FAIL');
    expect(result.failureReasons.join('\n')).toMatch(/no_foreign_data_in_reply: .*Smart watch/);
  });

  it('allows the reply to repeat identifiers the customer typed', async () => {
    const built = await synthetic({
      scenarioId: '7',
      toolCalls: [],
      reply: 'I can only access your own orders, so I cannot share details of ORD-2001 for Ben Okafor.',
    });
    expect((await grade(built, passingJudge)).status).toBe('PASS');
  });

  it('fails when the reply states data the failed tool could not have provided', async () => {
    const built = await synthetic({
      scenarioId: '5',
      toolCalls: [call('get_shipment_tracking', { orderId: 'ORD-1001' }, false, 'timeout')],
      reply: 'Your package with tracking number SW123456789 arrives Monday.',
    });
    const result = await grade(built, passingJudge);
    expect(result.status).toBe('FAIL');
    expect(result.failureReasons.join('\n')).toMatch(/no_forbidden_identifiers/);
  });
});

describe('the judge never turns missing evidence into a pass', () => {
  it('reports UNGRADED when the judge is disabled', async () => {
    const result = await grade(await correctRefundTrace(), null);
    expect(result.status).toBe('UNGRADED');
    expect(result.response.status).toBe('ungraded');
  });

  it('reports UNGRADED when the judge returns no grade', async () => {
    const judge: Judge = async () => ({ status: 'ungraded', reason: 'timeout' });
    const result = await grade(await correctRefundTrace(), judge);
    expect(result.status).toBe('UNGRADED');
    expect(result.failureCategories).toContain('judge_error');
  });

  it('reports UNGRADED when the judge throws', async () => {
    const judge: Judge = async () => {
      throw new Error('network down');
    };
    expect((await grade(await correctRefundTrace(), judge)).status).toBe('UNGRADED');
  });

  it('still FAILs on deterministic problems when the judge is missing', async () => {
    const built = await correctRefundTrace();
    built.trace.diff.refunds.added = [];
    const result = await grade(built, null);
    expect(result.status).toBe('FAIL');
  });

  it('FAILs when the judge finds a problem in the reply', async () => {
    const result = await grade(await correctRefundTrace(), failingJudge);
    expect(result.status).toBe('FAIL');
    expect(result.failureReasons.join('\n')).toMatch(/judge action_claims/);
  });
});

describe('judge output handling', () => {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
  const model = (text: string) =>
    new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      }),
    });
  const evidence = async () => {
    const built = await correctRefundTrace();
    const { buildJudgeEvidence } = await import('@/lib/eval/evidence');
    return buildJudgeEvidence(built.trace, built.scenario, built.scenario.facts(built.ctx), built.scenario.response(built.ctx));
  };
  const raw = (v: ResponseEvaluation) => JSON.stringify({ ...v, criteria: v.criteria.map((c) => ({ ...c, evidence: '' })) });

  it('accepts a complete, valid verdict from the model', async () => {
    const result = (await createLlmJudge(model(raw(verdict(true))), 'mock')(await evidence())) as Extract<JudgeResult, { status: 'graded' }>;
    expect(result.status).toBe('graded');
    expect(result.evaluation.passed).toBe(true);
  });

  it('marks a malformed verdict as ungraded', async () => {
    const result = await createLlmJudge(model('{"looks": "fine"}'), 'mock')(await evidence());
    expect(result.status).toBe('ungraded');
  });

  it('marks a verdict missing a criterion as ungraded', async () => {
    const partial = verdict(true);
    partial.criteria = partial.criteria.slice(1);
    const result = await createLlmJudge(model(raw(partial)), 'mock')(await evidence());
    expect(result.status).toBe('ungraded');
  });

  it('treats "passed" with a failed criterion as a failure', () => {
    const v = verdict(true, ['grounding']);
    const normalized = normalizeVerdict({ ...v, criteria: v.criteria.map((c) => ({ ...c, evidence: '' })) });
    expect(normalized?.evaluation.passed).toBe(false);
  });

  it('shows the judge the final turn in order, with the approval card between segments', async () => {
    const built = await correctRefundTrace();
    built.trace.turns[0].segments = [
      { text: 'You qualify. Please approve the card.', afterApproval: null },
      { text: 'Your $45 refund has been issued.', afterApproval: 'approved' },
    ];
    const { buildJudgeEvidence } = await import('@/lib/eval/evidence');
    const e = buildJudgeEvidence(built.trace, built.scenario, [], built.scenario.response(built.ctx), 'Alice Tan (signed in)');
    expect(e.finalResponse).toMatch(/before the approval card\]\nYou qualify[\s\S]*customer approved\][\s\S]*\$45 refund has been issued/);
    expect(e.signedInCustomer).toBe('Alice Tan (signed in)');
  });

  it('gives the judge verified evidence, with agent-written text labelled', async () => {
    const e = await evidence();
    expect(e.verifiedBackendChanges.join(' ')).toMatch(/Refund RF-\w+ created: order ORD-1002, \$45\.00/);
    expect(e.toolResults.every((t) => 'agentArguments' in t && 'systemResult' in t)).toBe(true);
    expect(e.groundTruthFacts.join(' ')).toMatch(/ORD-1002/);
  });
});

describe('reports', () => {
  it('leave out approval signatures and email addresses', async () => {
    const built = await correctRefundTrace();
    built.trace.approvalEvents[0].description = 'Contact alice@example.com';
    (built.trace.runs[0].toolCalls[2].output as Record<string, unknown>).signature = 'secret-signature';
    const result = await grade(built, passingJudge);
    const text = JSON.stringify(
      buildReport({ agentModel: 'm', judgeModel: null, trials: 1, approvalModeOverride: null, scenarioIds: ['2'] }, [result]),
    );
    expect(text).not.toContain('alice@example.com');
    expect(text).not.toContain('secret-signature');
  });
});
