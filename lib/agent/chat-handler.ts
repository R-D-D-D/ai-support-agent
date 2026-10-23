// Handles one chat request: checks the session, validates input, takes the
// per-customer run lock, runs the agent, and streams the reply (including
// every tool call) back to the browser.

import { randomUUID } from 'node:crypto';
import { createAgentUIStreamResponse, safeValidateUIMessages, type UIMessage } from 'ai';
import { z } from 'zod';
import { getSessionCustomer } from '@/lib/auth/current-customer';
import { unauthorized } from '@/lib/auth/session';
import { startRun } from '@/lib/agent/run-log';
import { acquireRunLock, releaseRunLock } from '@/lib/agent/run-lock';
import { createSupportAgent } from '@/lib/agent/support-agent';
import { createGateway } from '@/lib/gateway/tool-gateway';
import { FAULT_MODES, SERVICE_NAMES, type FaultConfig } from '@/lib/types';
import type { LanguageModel } from 'ai';

export const MAX_MESSAGE_CHARS = 2000;
export const MAX_HISTORY_MESSAGES = 20;

const faultConfigSchema = z
  .partialRecord(z.enum(SERVICE_NAMES as [string, ...string[]]), z.enum(FAULT_MODES as [string, ...string[]]))
  .default({});

const bodySchema = z.object({
  messages: z.array(z.unknown()).min(1).max(200),
  faultConfig: faultConfigSchema,
});

function messageText(message: UIMessage): string {
  return message.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim();
}

// Keeps the most recent messages and makes sure the history starts with a
// user message.
function trimHistory(messages: UIMessage[]): UIMessage[] {
  const recent = messages.slice(-MAX_HISTORY_MESSAGES);
  const firstUser = recent.findIndex((m) => m.role === 'user');
  return firstUser === -1 ? [] : recent.slice(firstUser);
}

function jsonError(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
}

// `model` is injectable so tests can run the route with a mock model.
export async function handleChat(req: Request, options: { model?: LanguageModel } = {}): Promise<Response> {
  const customer = await getSessionCustomer(req);
  if (!customer) return unauthorized();

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, 'invalid_request', 'The request body is not valid.');

  const validated = await safeValidateUIMessages({ messages: parsed.data.messages });
  if (!validated.success) return jsonError(400, 'invalid_messages', 'The chat history is not valid.');
  // The browser cannot inject system messages.
  const messages = trimHistory(validated.data.filter((m) => m.role !== 'system'));

  const last = messages.at(-1);
  if (!last || last.role !== 'user') {
    return jsonError(400, 'invalid_messages', 'The last message must come from the customer.');
  }
  const userText = messageText(last);
  if (!userText) return jsonError(400, 'empty_message', 'The message is empty.');
  if (userText.length > MAX_MESSAGE_CHARS) {
    return jsonError(413, 'message_too_long', `Messages are limited to ${MAX_MESSAGE_CHARS} characters.`);
  }

  if (!options.model && !process.env.OPENAI_API_KEY) {
    return jsonError(503, 'model_not_configured', 'OPENAI_API_KEY is not set on the server.');
  }

  const runId = randomUUID();
  if (!acquireRunLock(customer.id, runId)) {
    return jsonError(409, 'run_in_progress', 'The assistant is still answering your previous message.');
  }

  const faultConfig = parsed.data.faultConfig as FaultConfig;
  const recorder = startRun({ runId, customerId: customer.id, faultConfig, userMessage: userText });
  const release = () => releaseRunLock(customer.id, runId);

  try {
    const gateway = createGateway({ customerId: customer.id, faultConfig, recorder });
    const agent = createSupportAgent({ gateway, customerName: customer.name, model: options.model });

    return await createAgentUIStreamResponse({
      agent,
      uiMessages: messages,
      abortSignal: req.signal,
      headers: { 'X-Run-Id': runId },
      onStepEnd: (step) => {
        recorder.recordStep({
          text: step.text,
          finishReason: step.finishReason,
          inputTokens: step.usage.inputTokens,
          outputTokens: step.usage.outputTokens,
        });
      },
      onEnd: ({ isAborted }) => {
        recorder.finish(isAborted ? 'aborted' : 'completed');
        release();
      },
      onError: (error) => {
        console.error('agent run failed', runId, error);
        recorder.finish('error', error instanceof Error ? error.message : String(error));
        release();
        return 'Sorry, something went wrong on our side while answering. Please try again in a moment.';
      },
    });
  } catch (error) {
    recorder.finish('error', error instanceof Error ? error.message : String(error));
    release();
    return jsonError(500, 'internal_error', 'The assistant could not start.');
  }
}
