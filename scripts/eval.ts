// Real-model evaluation runner.
//
//   pnpm eval                         all scenarios, 1 trial, with the judge
//   pnpm eval --scenarios 2,5,A       selected scenarios
//   pnpm eval --trials 3              repeated trials (reliability run)
//   pnpm eval --no-judge              deterministic grading only
//   pnpm eval --approval-mode deny    answer approval cards this way where the
//                                     scenario allows it (approve | deny | leave_pending)
//   pnpm eval --verbose               print every failed check
//
// Needs OPENAI_API_KEY (from .env.local or the environment). Exit code is 1 if
// any trial FAILed, 2 if none failed but some could not be graded while the
// judge was enabled, and 0 otherwise.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MODEL } from '@/lib/agent/support-agent';
import { evaluateTrial } from '@/lib/eval/evaluate';
import { createLlmJudge, judgeModelId } from '@/lib/eval/judge';
import { buildReport, formatSummary, summarize } from '@/lib/eval/report';
import { findScenarios } from '@/lib/eval/scenarios';
import type { ApprovalMode, TrialResult } from '@/lib/eval/types';

try {
  process.loadEnvFile('.env.local');
} catch {
  // No .env.local; rely on the environment.
}
process.env.RUN_LOG_CONSOLE = 'off';

function parseArgs(argv: string[]) {
  const args = { scenarios: undefined as string[] | undefined, trials: 1, judge: true, approvalMode: undefined as ApprovalMode | undefined, out: 'eval-results', verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const value = () => inline ?? argv[++i];
    switch (flag) {
      case '--scenarios':
        args.scenarios = value().split(',').filter(Boolean);
        break;
      case '--trials':
        args.trials = Math.max(1, Number.parseInt(value(), 10) || 1);
        break;
      case '--no-judge':
        args.judge = false;
        break;
      case '--approval-mode': {
        const mode = value();
        if (!['approve', 'deny', 'leave_pending'].includes(mode)) throw new Error(`Unknown approval mode: ${mode}`);
        args.approvalMode = mode as ApprovalMode;
        break;
      }
      case '--out':
        args.out = value();
        break;
      case '--verbose':
        args.verbose = true;
        break;
      default:
        throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2).filter((a) => a !== '--'));
  if (!process.env.OPENAI_API_KEY) {
    console.error('Set OPENAI_API_KEY (for example in .env.local) first. Deterministic tests run with: pnpm test');
    process.exit(1);
  }
  const scenarios = findScenarios(args.scenarios);
  const judge = args.judge ? createLlmJudge() : null;
  const agentModel = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  console.log(
    `Evaluating ${scenarios.length} scenario(s) x ${args.trials} trial(s). Agent model ${agentModel}; judge ${
      judge ? judgeModelId() : 'disabled'
    }${args.approvalMode ? `; approval mode override ${args.approvalMode}` : ''}.`,
  );

  const results: TrialResult[] = [];
  for (const scenario of scenarios) {
    for (let trial = 1; trial <= args.trials; trial++) {
      const result = await evaluateTrial(scenario, { trial, approvalMode: args.approvalMode, judge });
      results.push(result);
      const tokens = result.trace.runs.reduce((n, r) => n + r.usage.inputTokens + r.usage.outputTokens, 0);
      console.log(
        `  ${result.status.padEnd(8)} ${scenario.id}. ${scenario.title} [trial ${trial}, ${result.trace.approvalMode}] ${(result.trace.durationMs / 1000).toFixed(1)}s, ${tokens} agent tokens`,
      );
      const reasons = args.verbose ? result.failureReasons : result.failureReasons.slice(0, 3);
      for (const reason of reasons) console.log(`           - ${reason}`);
      if (result.status === 'UNGRADED' && judge && result.response.judge.status === 'ungraded') {
        console.log(`           - ${result.response.judge.reason}`);
      }
    }
  }

  const report = buildReport(
    {
      agentModel,
      judgeModel: judge ? judgeModelId() : null,
      trials: args.trials,
      approvalModeOverride: args.approvalMode ?? null,
      scenarioIds: scenarios.map((s) => s.id),
    },
    results,
  );
  mkdirSync(args.out, { recursive: true });
  const file = join(args.out, `eval-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  writeFileSync(join(args.out, 'latest.json'), JSON.stringify(report, null, 2));

  const summary = summarize(results);
  console.log(formatSummary(summary, !!judge));
  console.log(`Detailed report: ${file}`);
  process.exit(summary.fail > 0 ? 1 : judge && summary.ungraded > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
