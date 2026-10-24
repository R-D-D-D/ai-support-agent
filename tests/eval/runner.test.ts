// Runs scenarios through the real trial runner and chat handler with a
// scripted mock model. This proves the runner answers approval cards through
// the production flow in each approval mode, keeps real multi-turn history,
// and that grading reaches the right verdict end to end without an API key.

import { describe, expect, it } from 'vitest';
import { evaluateTrial } from '@/lib/eval/evaluate';
import type { Judge } from '@/lib/eval/judge';
import { findScenarios } from '@/lib/eval/scenarios';
import { JUDGE_CRITERIA, type ApprovalMode } from '@/lib/eval/types';
import { scriptedModel, type ScriptedStep } from '../helpers';

const passingJudge: Judge = async () => ({
  status: 'graded',
  model: 'mock-judge',
  evaluation: {
    passed: true,
    criteria: JUDGE_CRITERIA.map((name) => ({ name, applicable: true, passed: true, reason: 'ok' })),
    problems: [],
  },
});

const check = { toolCalls: [{ name: 'check_refund_eligibility', input: { orderId: 'ORD-1002', claim: 'delayed' } }] };
const proposeRefund = (text: string): ScriptedStep => ({
  text,
  toolCalls: [{ name: 'issue_refund', input: { orderId: 'ORD-1002', claim: 'delayed' } }],
});

async function run(id: string, steps: ScriptedStep[], approvalMode?: ApprovalMode) {
  const [scenario] = findScenarios([id]);
  return evaluateTrial(scenario, { trial: 1, approvalMode, model: scriptedModel(steps), judge: passingJudge });
}

describe('approval modes through the real approval flow', () => {
  it('approve: the refund is created and the trial passes', async () => {
    const result = await run('2', [check, proposeRefund('It qualifies.'), { text: 'Your $45 refund has been issued.' }], 'approve');
    expect(result.failureReasons).toEqual([]);
    expect(result.status).toBe('PASS');
    expect(result.trace.approvalEvents).toMatchObject([{ tool: 'issue_refund', orderId: 'ORD-1002', decision: 'approved' }]);
    expect(result.trace.diff.refunds.added).toMatchObject([{ orderId: 'ORD-1002', amount: 45, issuedBy: 'bot' }]);
    expect(result.trace.finalResponse).toContain('$45 refund has been issued');
  });

  it('deny: nothing is refunded and the trial passes', async () => {
    const result = await run('2', [check, proposeRefund('It qualifies.'), { text: 'Understood, no refund was issued.' }], 'deny');
    expect(result.failureReasons).toEqual([]);
    expect(result.status).toBe('PASS');
    expect(result.trace.approvalEvents[0].decision).toBe('denied');
    expect(result.trace.diff.refunds.added).toEqual([]);
  });

  it('leave_pending: nothing is refunded, the approval stays recorded, and the trial passes', async () => {
    const result = await run('2', [check, proposeRefund('Please approve the refund on screen.')], 'leave_pending');
    expect(result.failureReasons).toEqual([]);
    expect(result.status).toBe('PASS');
    expect(result.trace.diff.refunds.added).toEqual([]);
    expect(result.trace.after.approvals).toMatchObject([{ tool: 'issue_refund', usedAt: null }]);
  });

  it('fails when the agent claims success in a scenario where the customer declined', async () => {
    // The model "says" the refund went through, but the customer declined.
    const result = await run('A', [check, proposeRefund('It qualifies.'), { text: 'Done! Refund RF-FAKE01 issued.' }]);
    expect(result.status).toBe('FAIL');
    expect(result.failureReasons.join('\n')).toMatch(/cited_ids_exist/);
  });

  it('fails when the agent never shows the required approval card', async () => {
    const result = await run('2', [check, { text: 'You qualify, but I will not refund it.' }], 'approve');
    expect(result.status).toBe('FAIL');
    expect(result.failureReasons.join('\n')).toMatch(/refunds_match|approvals_match/);
  });
});

describe('multi-turn scenarios keep the real conversation', () => {
  it('D: a repeated request after a refund creates no duplicate', async () => {
    const result = await run('D', [
      check,
      proposeRefund('It qualifies.'),
      { text: 'Your $45 refund has been issued.' },
      // Turn 2: the model checks again and tries to refund again.
      check,
      proposeRefund('Let me refund that.'),
      { text: 'Your mug set was already refunded earlier; no second refund is needed.' },
    ]);
    expect(result.trace.turns).toHaveLength(2);
    // The second attempt is refused by policy before any card is shown.
    expect(result.trace.approvalEvents).toHaveLength(1);
    expect(result.trace.diff.refunds.added).toHaveLength(1);
    expect(result.status).toBe('PASS');
    // History really carried over: the second turn's request included turn 1.
    expect(result.trace.messages.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  it('C: acting on the original, wrong order fails', async () => {
    const wrongCheck = { toolCalls: [{ name: 'check_refund_eligibility', input: { orderId: 'ORD-1003', claim: 'delayed' } }] };
    const result = await run('C', [
      wrongCheck,
      { text: 'ORD-1003 is not eligible yet.' },
      // Turn 2: the model ignores the correction and stays on ORD-1003.
      wrongCheck,
      { text: 'ORD-1003 is still not eligible.' },
    ]);
    expect(result.status).toBe('FAIL');
    expect(result.failureReasons.join('\n')).toMatch(/refunds_match: missing refund: ORD-1002/);
  });
});
