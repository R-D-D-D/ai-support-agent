// Turns trial results into a JSON report and a short terminal summary.
// Reports leave out approval signatures, cookies, and raw chat messages, and
// replace email addresses, so they are safe to keep and share.

import type { FailureCategory, StateDiff, TrialResult } from '@/lib/eval/types';

export interface RunConfig {
  agentModel: string;
  judgeModel: string | null;
  trials: number;
  approvalModeOverride: string | null;
  scenarioIds: string[];
}

export interface ScenarioSummary {
  id: string;
  title: string;
  trials: number;
  pass: number;
  fail: number;
  ungraded: number;
}

export interface Summary {
  total: number;
  pass: number;
  fail: number;
  ungraded: number;
  // PASS / (PASS + FAIL). Ungraded trials are left out, not counted as passes.
  passRateOfGraded: number | null;
  byScenario: ScenarioSummary[];
  failureCategories: Partial<Record<FailureCategory, number>>;
}

export function summarize(results: TrialResult[]): Summary {
  const byScenario = new Map<string, ScenarioSummary>();
  const categories: Partial<Record<FailureCategory, number>> = {};
  for (const r of results) {
    const s = byScenario.get(r.scenarioId) ?? { id: r.scenarioId, title: r.scenarioTitle, trials: 0, pass: 0, fail: 0, ungraded: 0 };
    s.trials += 1;
    if (r.status === 'PASS') s.pass += 1;
    else if (r.status === 'FAIL') s.fail += 1;
    else s.ungraded += 1;
    byScenario.set(r.scenarioId, s);
    for (const c of r.failureCategories) categories[c] = (categories[c] ?? 0) + 1;
  }
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  return {
    total: results.length,
    pass,
    fail,
    ungraded: results.length - pass - fail,
    passRateOfGraded: pass + fail > 0 ? pass / (pass + fail) : null,
    byScenario: [...byScenario.values()],
    failureCategories: categories,
  };
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DROP_KEYS = new Set(['signature', 'cookie', 'authorization', 'passwordHash', 'apiKey']);

// Removes secrets and replaces email addresses anywhere in a value.
export function redact<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, v) => {
      if (DROP_KEYS.has(key)) return undefined;
      if (typeof v === 'string') return v.replace(EMAIL, '<email>');
      return v;
    }),
  );
}

function compactDiff(diff: StateDiff) {
  return {
    refundsAdded: diff.refunds.added,
    refundsChanged: diff.refunds.changed.map((c) => ({ id: c.id, fields: c.fields })),
    refundsRemoved: diff.refunds.removed.map((r) => r.id),
    refundRequestsAdded: diff.refundRequests.added,
    refundRequestsChanged: diff.refundRequests.changed.map((c) => ({ id: c.id, fields: c.fields })),
    ticketsAdded: diff.tickets.added,
    approvalsAdded: diff.approvals.added.map((a) => ({ tool: a.tool, input: a.inputKey, description: a.description, used: a.usedAt !== null })),
  };
}

export function trialReport(r: TrialResult) {
  const agentUsage = r.trace.runs.reduce(
    (sum, run) => ({ inputTokens: sum.inputTokens + run.usage.inputTokens, outputTokens: sum.outputTokens + run.usage.outputTokens }),
    { inputTokens: 0, outputTokens: 0 },
  );
  return redact({
    scenarioId: r.scenarioId,
    scenarioTitle: r.scenarioTitle,
    trial: r.trial,
    status: r.status,
    failureReasons: r.failureReasons,
    failureCategories: r.failureCategories,
    config: { approvalMode: r.trace.approvalMode, faultConfig: r.trace.faultConfig, customerId: r.trace.customerId },
    input: r.trace.turns.map((t) => ({ turn: t.turn, customer: t.user, approvalMode: t.approvalMode })),
    transcript: r.trace.turns,
    finalResponse: r.trace.finalResponse,
    durationMs: r.trace.durationMs,
    usage: {
      agent: agentUsage,
      judge: r.response.judge.status === 'graded' ? r.response.judge.usage ?? null : null,
    },
    runs: r.trace.runs.map((run) => ({
      runId: run.runId,
      status: run.status,
      error: run.error,
      steps: run.steps,
      trigger: run.userMessage,
      toolCalls: run.toolCalls,
    })),
    approvalEvents: r.trace.approvalEvents,
    stateDiff: compactDiff(r.trace.diff),
    grades: {
      outcome: r.outcome,
      behavior: r.behavior,
      response: { status: r.response.status, checks: r.response.checks, judge: r.response.judge },
    },
  });
}

export function buildReport(config: RunConfig, results: TrialResult[]) {
  return {
    generatedAt: new Date().toISOString(),
    config,
    summary: summarize(results),
    note: 'Pass rates come from a small number of trials and are not a statistical reliability estimate.',
    trials: results.map(trialReport),
  };
}

export function formatSummary(summary: Summary, judgeEnabled: boolean): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('Scenario                                                      PASS  FAIL  UNGRADED');
  for (const s of summary.byScenario) {
    const name = `${s.id}. ${s.title}`.slice(0, 60).padEnd(60);
    lines.push(`${name}  ${String(s.pass).padStart(4)}  ${String(s.fail).padStart(4)}  ${String(s.ungraded).padStart(8)}`);
  }
  lines.push('');
  lines.push(`Trials: ${summary.total}  pass ${summary.pass}  fail ${summary.fail}  ungraded ${summary.ungraded}`);
  lines.push(
    `Pass rate over fully graded trials: ${
      summary.passRateOfGraded === null ? 'n/a (no fully graded trials)' : `${Math.round(summary.passRateOfGraded * 100)}% (${summary.pass}/${summary.pass + summary.fail})`
    }`,
  );
  const cats = Object.entries(summary.failureCategories);
  lines.push(`Failure categories: ${cats.length ? cats.map(([c, n]) => `${c} ${n}`).join(', ') : 'none'}`);
  if (!judgeEnabled) lines.push('Response judge disabled: replies were checked for exact identifiers only and are marked ungraded.');
  return lines.join('\n');
}
