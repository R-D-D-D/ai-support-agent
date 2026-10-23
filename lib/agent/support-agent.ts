// Builds the support agent for one signed-in customer and one request.

import { isStepCount, ToolLoopAgent, type LanguageModel } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { buildSystemPrompt } from '@/lib/agent/system-prompt';
import { buildTools } from '@/lib/agent/tools';
import type { Gateway } from '@/lib/gateway/tool-gateway';

export const MAX_STEPS = 8;
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export function defaultModel(): LanguageModel {
  return anthropic(process.env.ANTHROPIC_MODEL || DEFAULT_MODEL);
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
