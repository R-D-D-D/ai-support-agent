// Builds the support agent for one signed-in customer and one request.

import { isStepCount, ToolLoopAgent, type LanguageModel, type ModelMessage } from 'ai';
import { openai } from '@ai-sdk/openai';
import type { ApprovalTool } from '@/lib/agent/approvals';
import { buildSystemPrompt } from '@/lib/agent/system-prompt';
import { buildTools } from '@/lib/agent/tools';
import { approvalSigningSecret } from '@/lib/auth/session';
import type { Gateway } from '@/lib/gateway/tool-gateway';

export const MAX_STEPS = 8;
// The default openai() factory uses the OpenAI Responses API.
export const DEFAULT_MODEL = 'gpt-6-astra';

export function defaultModel(): LanguageModel {
  return openai(process.env.OPENAI_MODEL || DEFAULT_MODEL);
}

// True when this tool call already has an approval request in the history,
// which means the customer has answered it and the AI SDK is about to run it.
function isApprovalFollowUp(messages: ModelMessage[], toolCallId: string): boolean {
  return messages.some(
    (m) =>
      m.role === 'assistant' &&
      Array.isArray(m.content) &&
      m.content.some((p) => p.type === 'tool-approval-request' && p.toolCallId === toolCallId),
  );
}

export function createSupportAgent(input: {
  gateway: Gateway;
  customerName: string;
  model?: LanguageModel;
  now?: Date;
}) {
  const { gateway } = input;

  // The AI SDK calls this twice for a tool that changes data: once when the
  // model asks for it (to decide whether to show an approval card), and again
  // after the customer answers (to check the approval before running it).
  const approve =
    (tool: ApprovalTool) =>
    (args: unknown, options: { toolCallId: string; messages: ModelMessage[] }) =>
      isApprovalFollowUp(options.messages, options.toolCallId)
        ? gateway.revalidateApproval(tool, args, options.toolCallId)
        : gateway.requestApproval(tool, args, options.toolCallId);

  return new ToolLoopAgent({
    model: input.model ?? defaultModel(),
    instructions: buildSystemPrompt({ customerName: input.customerName, now: input.now ?? new Date() }),
    tools: buildTools(gateway),
    stopWhen: isStepCount(MAX_STEPS),
    toolApproval: {
      issue_refund: approve('issue_refund'),
      request_staff_refund: approve('request_staff_refund'),
      escalate_to_human: approve('escalate_to_human'),
    },
    // The SDK signs each approval request and rejects follow-ups whose
    // signature does not match, so the browser cannot invent an approval.
    experimental_toolApprovalSecret: approvalSigningSecret(),
  });
}

export type SupportAgent = ReturnType<typeof createSupportAgent>;
