// Builds the support agent for one signed-in customer and one request.

import { isStepCount, ToolLoopAgent, type LanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { buildSystemPrompt } from '@/lib/agent/system-prompt';
import { buildTools } from '@/lib/agent/tools';
import type { Gateway } from '@/lib/gateway/tool-gateway';

export const MAX_STEPS = 8;
// The default openai() factory uses the OpenAI Responses API.
export const DEFAULT_MODEL = 'gpt-6-astra';

export function defaultModel(): LanguageModel {
  return openai(process.env.OPENAI_MODEL || DEFAULT_MODEL);
}

export function createSupportAgent(input: {
  gateway: Gateway;
  customerName: string;
  model?: LanguageModel;
  now?: Date;
}) {
  return new ToolLoopAgent({
    model: input.model ?? defaultModel(),
    instructions: buildSystemPrompt({ customerName: input.customerName, now: input.now ?? new Date() }),
    tools: buildTools(input.gateway),
    stopWhen: isStepCount(MAX_STEPS),
  });
}

export type SupportAgent = ReturnType<typeof createSupportAgent>;
