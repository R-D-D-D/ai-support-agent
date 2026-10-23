// Audit log of agent runs. One record per run: who asked, what the agent
// called, what each call returned, and how the run ended. Records are kept in
// the in-memory store for the Runs tab and printed as one JSON line when the
// run ends so the server logs keep a copy.

import { getStore } from '@/lib/data/store';
import type { FaultConfig, ServiceName } from '@/lib/types';
import type { ToolError } from '@/lib/gateway/types';

export interface ServiceCallRecord {
  service: ServiceName;
  attempts: number;
  ok: boolean;
  errorCode?: string;
}

export interface ToolCallRecord {
  tool: string;
  input: unknown;
  ok: boolean;
  output?: unknown;
  error?: ToolError;
  serviceCalls: ServiceCallRecord[];
  durationMs: number;
  at: string;
}

export type RunStatus = 'running' | 'completed' | 'error' | 'aborted';

export interface RunRecord {
  runId: string;
  customerId: string;
  startedAt: string;
  endedAt: string | null;
  status: RunStatus;
  faultConfig: FaultConfig;
  userMessage: string;
  toolCalls: ToolCallRecord[];
  steps: number;
  finalText: string;
  finishReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
  error: string | null;
}

const MAX_STORED_RUNS = 200;

export class RunRecorder {
  constructor(readonly record: RunRecord) {}

  recordToolCall(call: ToolCallRecord): void {
    this.record.toolCalls.push(call);
  }

  recordStep(step: {
    text: string;
    finishReason: string;
    inputTokens?: number;
    outputTokens?: number;
  }): void {
    this.record.steps += 1;
    if (step.text) this.record.finalText = step.text;
    this.record.finishReason = step.finishReason;
    this.record.usage.inputTokens += step.inputTokens ?? 0;
    this.record.usage.outputTokens += step.outputTokens ?? 0;
  }

  // Ends the run. Only the first call has an effect, so the success, error,
  // and abort paths can all call it safely.
  finish(status: Exclude<RunStatus, 'running'>, error?: string): void {
    if (this.record.status !== 'running') return;
    this.record.status = status;
    this.record.endedAt = new Date().toISOString();
    if (error) this.record.error = error;
    if (process.env.NODE_ENV !== 'test') {
      console.log(JSON.stringify({ type: 'agent_run', ...this.record }));
    }
  }
}

export function startRun(input: {
  runId: string;
  customerId: string;
  faultConfig: FaultConfig;
  userMessage: string;
}): RunRecorder {
  const record: RunRecord = {
    ...input,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'running',
    toolCalls: [],
    steps: 0,
    finalText: '',
    finishReason: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    error: null,
  };
  const store = getStore();
  store.runs.push(record);
  if (store.runs.length > MAX_STORED_RUNS) store.runs.splice(0, store.runs.length - MAX_STORED_RUNS);
  return new RunRecorder(record);
}

export function listRuns(customerId: string, limit = 20): RunRecord[] {
  return getStore()
    .runs.filter((r) => r.customerId === customerId)
    .slice(-limit)
    .reverse();
}
