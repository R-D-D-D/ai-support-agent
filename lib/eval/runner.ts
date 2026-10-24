// Runs one trial of a scenario against the real chat handler, exactly as the
// browser would: a signed session cookie, the full chat history on every
// request, and approval answers sent back through the normal approval flow
// (signed by the AI SDK and checked against the server's approval records).
//
// Each trial starts from a freshly seeded store with no run locks, approval
// records, or login lockouts left over, so trials are independent. Trials must
// run one after another because the store is shared process memory.

import type { LanguageModel, UIMessage } from 'ai';
import { handleChat } from '@/lib/agent/chat-handler';
import { resetRunLocks } from '@/lib/agent/run-lock';
import { resetLimiter } from '@/lib/auth/login-limiter';
import { createSessionToken, SESSION_COOKIE } from '@/lib/auth/session';
import { answerApprovals, openApprovals, readAssistantMessage } from '@/lib/chat/ui-stream';
import { getStore, resetStore, type Store } from '@/lib/data/store';
import { diffSnapshots, takeSnapshot } from '@/lib/eval/snapshot';
import type { ApprovalEvent, ApprovalMode, Scenario, TrialTrace, TurnTrace } from '@/lib/eval/types';

// Safety limit on approval rounds within one customer turn.
const MAX_APPROVAL_ROUNDS = 3;

export interface RunTrialOptions {
  trial: number;
  // Overrides the scenario's default approval mode when it allows that.
  approvalMode?: ApprovalMode;
  // Injected in tests to replace the real language model.
  model?: LanguageModel;
  // Set when the caller already called freshTrialState() and read the seeded
  // store (for ground-truth facts) before the trial starts.
  alreadyReset?: boolean;
}

export function resolveApprovalMode(scenario: Scenario, override?: ApprovalMode): ApprovalMode {
  return override && scenario.approvalModeOverridable ? override : scenario.defaultApprovalMode;
}

// Resets everything a trial depends on and returns the fresh store.
export function freshTrialState(): Store {
  const store = resetStore();
  resetRunLocks();
  resetLimiter();
  return store;
}

function textOf(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

// When a response continues an earlier assistant message (after an approval
// answer), only the parts after `previousPartCount` are new.
function textAfter(message: UIMessage | undefined, previousPartCount: number): string {
  return (message?.parts ?? [])
    .slice(previousPartCount)
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

export async function runTrial(scenario: Scenario, options: RunTrialOptions): Promise<TrialTrace> {
  const started = Date.now();
  if (!options.alreadyReset) freshTrialState();
  const approvalMode = resolveApprovalMode(scenario, options.approvalMode);
  const faultConfig = scenario.faultConfig ?? {};
  const before = takeSnapshot(getStore());
  const runsBefore = getStore().runs.length;
  const cookie = `${SESSION_COOKIE}=${await createSessionToken(scenario.customerId)}`;

  const messages: UIMessage[] = [];
  const turns: TurnTrace[] = [];
  const approvalEvents: ApprovalEvent[] = [];

  async function send(history: UIMessage[], continueFrom: UIMessage | undefined, turn: TurnTrace) {
    const res = await handleChat(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ messages: history, faultConfig }),
      }),
      { model: options.model },
    );
    turn.httpStatuses.push(res.status);
    if (!res.ok) {
      turn.errors.push(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return undefined;
    }
    try {
      return await readAssistantMessage(res, continueFrom);
    } catch (err) {
      turn.errors.push(`Could not read the response stream: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  for (const [index, spec] of scenario.turns.entries()) {
    const turnNumber = index + 1;
    const mode = spec.approval ?? approvalMode;
    const turn: TurnTrace = {
      turn: turnNumber,
      user: spec.user,
      approvalMode: mode,
      assistantText: '',
      segments: [],
      httpStatuses: [],
      errors: [],
    };
    turns.push(turn);

    messages.push({ id: `user-${turnNumber}`, role: 'user', parts: [{ type: 'text', text: spec.user }] });
    let assistant = await send(messages, undefined, turn);
    const segments: TurnTrace['segments'] = [{ text: textOf(assistant), afterApproval: null }];

    for (let round = 0; assistant && round < MAX_APPROVAL_ROUNDS; round++) {
      const cards = openApprovals(assistant);
      if (cards.length === 0) break;
      const decision = mode === 'approve' ? 'approved' : mode === 'deny' ? 'denied' : 'left_pending';
      for (const card of cards) {
        const input = (card as { input?: { orderId?: string } }).input;
        approvalEvents.push({
          turn: turnNumber,
          tool: card.type.replace(/^tool-/, ''),
          approvalId: card.approval?.id ?? '',
          toolCallId: (card as { toolCallId?: string }).toolCallId ?? null,
          orderId: typeof input?.orderId === 'string' ? input.orderId.trim().toUpperCase() : null,
          description: card.approval?.requestReason ?? '',
          decision,
        });
      }
      if (mode === 'leave_pending') break;
      // Answer through the same mechanism as the chat UI, then continue.
      const answered = answerApprovals(assistant, mode === 'approve');
      const previousPartCount = answered.parts.length;
      // The stream reader extends the message it continues in place, so give
      // it a copy and keep `answered` as sent.
      const next = await send([...messages, answered], structuredClone(answered), turn);
      segments.push({ text: textAfter(next, previousPartCount), afterApproval: decision });
      assistant = next ?? answered;
    }

    if (assistant) messages.push(assistant);
    turn.segments = segments;
    turn.assistantText = segments.map((s) => s.text).filter(Boolean).join('\n');
  }

  const after = takeSnapshot(getStore());
  return {
    scenarioId: scenario.id,
    trial: options.trial,
    customerId: scenario.customerId,
    approvalMode,
    faultConfig,
    turns,
    messages,
    runs: structuredClone(getStore().runs.slice(runsBefore)),
    approvalEvents,
    before,
    after,
    diff: diffSnapshots(before, after),
    finalResponse: turns.at(-1)?.assistantText ?? '',
    durationMs: Date.now() - started,
  };
}
