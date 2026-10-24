// Runs and grades one trial.
//
// How the three grades combine into the overall status:
//   - FAIL if any outcome, behavior, or deterministic response check fails.
//     The judge is never asked to rescue these: a wrong backend state fails
//     the trial however good the reply sounds.
//   - FAIL if the judge graded the reply and it failed.
//   - UNGRADED if everything deterministic passed but the judge was disabled
//     or could not produce a valid verdict. Missing evidence is never a pass.
//   - PASS only when all three dimensions are verified.

import type { LanguageModel } from 'ai';
import { buildJudgeEvidence } from '@/lib/eval/evidence';
import {
  buildReference,
  gradeBehavior,
  gradeOutcome,
  gradeResponseDeterministic,
  type ReferenceData,
} from '@/lib/eval/graders';
import type { Judge } from '@/lib/eval/judge';
import { freshTrialState, resolveApprovalMode, runTrial } from '@/lib/eval/runner';
import type {
  ApprovalMode,
  FailureCategory,
  JudgeResult,
  OverallStatus,
  ResponseGrade,
  Scenario,
  ScenarioContext,
  TrialResult,
  TrialTrace,
} from '@/lib/eval/types';

export interface EvaluateOptions {
  trial: number;
  approvalMode?: ApprovalMode;
  model?: LanguageModel;
  // null means the judge is disabled for this run.
  judge: Judge | null;
}

export async function evaluateTrial(scenario: Scenario, options: EvaluateOptions): Promise<TrialResult> {
  const store = freshTrialState();
  const ctx: ScenarioContext = {
    approvalMode: resolveApprovalMode(scenario, options.approvalMode),
    store: structuredClone(store),
  };
  const reference = buildReference(store, scenario.customerId);
  const trace = await runTrial(scenario, {
    trial: options.trial,
    approvalMode: options.approvalMode,
    model: options.model,
    alreadyReset: true,
  });
  return gradeTrace(scenario, ctx, reference, trace, options.judge);
}

// Grades a finished trace. Separate from running so tests can grade synthetic traces.
export async function gradeTrace(
  scenario: Scenario,
  ctx: ScenarioContext,
  reference: ReferenceData,
  trace: TrialTrace,
  judge: Judge | null,
): Promise<TrialResult> {
  const outcome = gradeOutcome(trace, scenario.outcome(ctx), reference);
  const behavior = gradeBehavior(trace, scenario.behavior(ctx), reference);
  const responseExpectation = scenario.response(ctx);
  const responseChecks = gradeResponseDeterministic(trace, responseExpectation, reference);

  let judgeResult: JudgeResult;
  if (!judge) {
    judgeResult = { status: 'ungraded', reason: 'The response judge was disabled for this run.' };
  } else {
    const customer = ctx.store.customers.find((c) => c.id === scenario.customerId);
    const evidence = buildJudgeEvidence(
      trace,
      { id: scenario.id, title: scenario.title },
      scenario.facts(ctx),
      responseExpectation,
      customer ? `${customer.name} (signed in)` : scenario.customerId,
    );
    try {
      judgeResult = await judge(evidence);
    } catch (err) {
      judgeResult = { status: 'ungraded', reason: `The judge threw: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  const responseDeterministicFailed = responseChecks.some((c) => !c.passed && c.severity === 'error');
  const response: ResponseGrade = {
    status: responseDeterministicFailed
      ? 'fail'
      : judgeResult.status === 'ungraded'
        ? 'ungraded'
        : judgeResult.evaluation.passed
          ? 'pass'
          : 'fail',
    checks: responseChecks,
    judge: judgeResult,
  };

  const failedChecks = [...outcome.checks, ...behavior.checks, ...responseChecks].filter(
    (c) => !c.passed && c.severity === 'error',
  );
  const failureReasons = failedChecks.map((c) => `${c.name}: ${c.detail}`);
  const categories = new Set<FailureCategory>(failedChecks.map((c) => c.category));
  if (judgeResult.status === 'graded' && !judgeResult.evaluation.passed) {
    categories.add('response');
    const failedCriteria = judgeResult.evaluation.criteria.filter((c) => c.applicable && !c.passed);
    failureReasons.push(
      ...failedCriteria.map((c) => `judge ${c.name}: ${c.reason}`),
      ...judgeResult.evaluation.problems.map((p) => `judge: ${p}`),
    );
  }
  if (judge && judgeResult.status === 'ungraded') categories.add('judge_error');

  let status: OverallStatus;
  if (outcome.status === 'fail' || behavior.status === 'fail' || response.status === 'fail') status = 'FAIL';
  else if (response.status === 'ungraded') status = 'UNGRADED';
  else status = 'PASS';

  return {
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    trial: trace.trial,
    status,
    outcome,
    behavior,
    response,
    failureReasons,
    failureCategories: [...categories],
    trace,
  };
}
