import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createSessionToken, SESSION_COOKIE } from '@/lib/auth/session';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

export interface ScriptedStep {
  toolCalls?: { name: string; input: Record<string, unknown> }[];
  text?: string;
}

// A mock model that plays back a fixed script, one entry per agent step.
export function scriptedModel(steps: ScriptedStep[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[Math.min(call, steps.length - 1)];
      call += 1;
      const chunks: unknown[] = [];
      if (step.text) {
        chunks.push(
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: step.text },
          { type: 'text-end', id: 't1' },
        );
      }
      (step.toolCalls ?? []).forEach((tc, i) => {
        chunks.push({
          type: 'tool-call',
          toolCallId: `call-${call}-${i}`,
          toolName: tc.name,
          input: JSON.stringify(tc.input),
        });
      });
      chunks.push({
        type: 'finish',
        finishReason: { unified: step.toolCalls?.length ? 'tool-calls' : 'stop', raw: undefined },
        usage,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { stream: simulateReadableStream({ chunks: chunks as any, chunkDelayInMs: 0 }) };
    },
  });
}

export async function sessionCookie(customerId: string): Promise<string> {
  return `${SESSION_COOKIE}=${await createSessionToken(customerId)}`;
}

export function userMessage(text: string, id = 'm1') {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

export async function chatRequest(options: {
  cookie?: string;
  messages: unknown[];
  faultConfig?: Record<string, string>;
}): Promise<Request> {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: JSON.stringify({ messages: options.messages, faultConfig: options.faultConfig ?? {} }),
  });
}
