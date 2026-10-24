// Types for the evaluation harness. See "Evaluation" in README.md for how the
// pieces fit together.
//
// A scenario is run as one or more trials. Each trial produces a trace (what
// was said, which tools ran, which approvals were shown and how they were
// answered, and the backend state before and after). Three graders then look
// at the trace separately:
//   outcome  - did the backend end up in the expected state? (deterministic)
//   behavior - were the actions appropriate and authorized? (deterministic)
//   response - did the final reply describe what really happened?
//              (deterministic identifier checks plus an independent LLM judge)

import type { UIMessage } from 'ai';
import type { ApprovalRecord, ApprovalTool } from '@/lib/agent/approvals';
import type { RunRecord } from '@/lib/agent/run-log';
import type { Store } from '@/lib/data/store';
import type { FaultConfig, Refund, RefundRequest, Ticket } from '@/lib/types';

// How the simulated customer answers approval cards.
export type ApprovalMode = 'approve' | 'deny' | 'leave_pending';

export type ApprovalDecision = 'approved' | 'denied' | 'left_pending';

// One approval card the agent showed, and what the simulated customer did.
export interface ApprovalEvent {
  turn: number;
  tool: string;
  approvalId: string;
  toolCallId: string | null;
  orderId: string | null;
  description: string;
  decision: ApprovalDecision;
}

export interface TurnSpec {
  user: string;
  // Overrides the scenario's approval mode for this turn.
  approval?: ApprovalMode;
}

// Business records the evaluator compares before and after a trial.
export interface BusinessSnapshot {
  refunds: Refund[];
  refundRequests: RefundRequest[];
  tickets: Ticket[];
  approvals: ApprovalRecord[];
}

export interface CollectionDiff<T> {
  added: T[];
  removed: T[];
  changed: { id: string; before: T; after: T; fields: string[] }[];
}

export interface StateDiff {
  refunds: CollectionDiff<Refund>;
  refundRequests: CollectionDiff<RefundRequest>;
  tickets: CollectionDiff<Ticket>;
  approvals: CollectionDiff<ApprovalRecord>;
}

export interface TurnTrace {
  turn: number;
  user: string;
  approvalMode: ApprovalMode;
  // Every text part the agent wrote in this turn, in order, including text
  // written after an approval answer.
  assistantText: string;
  // The same text split at approval cards, as the customer saw it: text,
  // then the card and their answer, then the text that followed.
  segments: { text: string; afterApproval: ApprovalDecision | null }[];
  httpStatuses: number[];
  errors: string[];
}

export interface TrialTrace {
  scenarioId: string;
  trial: number;
  customerId: string;
  approvalMode: ApprovalMode;
  faultConfig: FaultConfig;
  turns: TurnTrace[];
  // The full chat history as the browser would hold it.
  messages: UIMessage[];
  runs: RunRecord[];
  approvalEvents: ApprovalEvent[];
  before: BusinessSnapshot;
  after: BusinessSnapshot;
  diff: StateDiff;
  // The agent's reply in the last turn.
  finalResponse: string;
  durationMs: number;
}

// ---- Expectations a scenario declares ----

export interface ExpectedRefund {
  orderId: string;
  amount: number;
  issuedBy: 'bot';
}

export interface ExpectedRefundRequest {
  orderId: string;
  amount: number;
  claim: 'delayed' | 'missing';
  status: 'pending';
}

export interface ExpectedApproval {
  tool: ApprovalTool;
  orderId?: string;
  decision: ApprovalDecision;
}

export interface OutcomeExpectation {
  // Exactly these new refunds and refund requests, no more and no fewer.
  refunds: ExpectedRefund[];
  refundRequests: ExpectedRefundRequest[];
  // How many new tickets are acceptable.
  tickets: { min: number; max: number };
  // Approval records still unused at the end (left pending by the customer).
  pendingApprovals: { tool: ApprovalTool; orderId?: string }[];
}

export interface BehaviorExpectation {
  // Each must succeed at least once (in any order).
  requiredSuccessfulTools: string[];
  // Each must have been called and failed with this error code.
  requiredFailedTools: { tool: string; code: string }[];
  // Must not be attempted at all, not even if the gateway would refuse it.
  forbiddenAttempts: string[];
  // Approval cards that must be shown (exactly once each).
  requiredApprovals: ExpectedApproval[];
  // Approval cards that may be shown but are not required.
  optionalApprovals: { tool: ApprovalTool }[];
  // Order ids the agent must never read or act on successfully.
  forbiddenOrderIds: string[];
}

export interface ResponseExpectation {
  // What a correct final reply must convey, in plain words, for the judge.
  mustConvey: string[];
  // What a correct final reply must not do, in plain words, for the judge.
  mustNot: string[];
  // Exact identifiers that must not appear in the final reply, for example a
  // tracking number the agent could not have retrieved.
  forbiddenStrings: string[];
}

export interface ScenarioContext {
  approvalMode: ApprovalMode;
  store: Store;
}

export interface Scenario {
  id: string;
  title: string;
  customerId: string;
  turns: TurnSpec[];
  faultConfig?: FaultConfig;
  // Default approval mode, and whether --approval-mode may override it.
  defaultApprovalMode: ApprovalMode;
  approvalModeOverridable: boolean;
  // Ground-truth facts, computed from the seeded store before the trial.
  facts: (ctx: ScenarioContext) => string[];
  outcome: (ctx: ScenarioContext) => OutcomeExpectation;
  behavior: (ctx: ScenarioContext) => BehaviorExpectation;
  response: (ctx: ScenarioContext) => ResponseExpectation;
}

// ---- Grades ----

export type FailureCategory =
  | 'business_state' // backend did not reach the expected state
  | 'approval' // approvals shown, answered, or recorded incorrectly
  | 'tool' // a tool failed unexpectedly
  | 'model_behavior' // the agent chose an inappropriate or unauthorized action
  | 'response' // the reply misrepresents what happened
  | 'run_error' // the agent run itself crashed or was refused
  | 'judge_error'; // the judge could not produce a valid grade

export interface Check {
  name: string;
  passed: boolean;
  category: FailureCategory;
  detail: string;
  // Warnings are recorded but do not fail the trial.
  severity: 'error' | 'warning';
}

export type GradeStatus = 'pass' | 'fail' | 'ungraded';

export interface DeterministicGrade {
  status: 'pass' | 'fail';
  checks: Check[];
}

export const JUDGE_CRITERIA = [
  'factual_accuracy',
  'grounding',
  'eligibility_communication',
  'action_claims',
  'uncertainty',
  'no_unauthorized_promises_or_disclosure',
  'next_step',
] as const;

export type JudgeCriterionName = (typeof JUDGE_CRITERIA)[number];

export interface ResponseEvaluation {
  passed: boolean;
  criteria: {
    name: JudgeCriterionName;
    applicable: boolean;
    passed: boolean;
    reason: string;
    evidence?: string;
  }[];
  problems: string[];
}

export type JudgeResult =
  | { status: 'graded'; evaluation: ResponseEvaluation; model: string; usage?: { inputTokens: number; outputTokens: number } }
  | { status: 'ungraded'; reason: string };

export interface ResponseGrade {
  status: GradeStatus;
  // Exact-identifier checks that run without the judge.
  checks: Check[];
  judge: JudgeResult;
}

export type OverallStatus = 'PASS' | 'FAIL' | 'UNGRADED';

export interface TrialResult {
  scenarioId: string;
  scenarioTitle: string;
  trial: number;
  status: OverallStatus;
  outcome: DeterministicGrade;
  behavior: DeterministicGrade;
  response: ResponseGrade;
  failureReasons: string[];
  failureCategories: FailureCategory[];
  trace: TrialTrace;
}
