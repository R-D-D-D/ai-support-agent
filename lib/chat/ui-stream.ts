// Helpers for code that talks to the chat endpoint outside a browser (tests and
// the scenario script): rebuild the assistant message from the streamed
// response, and answer approval cards the way the chat UI does.

import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';

// Reads a chat response body (server-sent events) into the final assistant
// message. Pass `continueFrom` when the response continues an earlier
// assistant message, as it does after an approval answer.
export async function readAssistantMessage(
  res: Response,
  continueFrom?: UIMessage,
): Promise<UIMessage | undefined> {
  const text = await res.text();
  const chunks = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length).trim())
    .filter((data) => data && data !== '[DONE]')
    .map((data) => JSON.parse(data) as UIMessageChunk);
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ message: continueFrom, stream })) last = message;
  return last;
}

type ApprovalPart = {
  type: string;
  state?: string;
  approval?: { id: string; requestReason?: string; [key: string]: unknown };
};

// Approval cards still waiting for an answer in a message.
export function openApprovals(message: UIMessage | undefined): ApprovalPart[] {
  return (message?.parts ?? []).filter(
    (p) => p.type.startsWith('tool-') && (p as ApprovalPart).state === 'approval-requested',
  ) as ApprovalPart[];
}

// Answers every open approval card in a message, like clicking Approve or
// Decline in the chat UI.
export function answerApprovals(message: UIMessage, approved: boolean): UIMessage {
  return {
    ...message,
    parts: message.parts.map((p) => {
      const part = p as ApprovalPart;
      if (!part.type.startsWith('tool-') || part.state !== 'approval-requested' || !part.approval) return p;
      return {
        ...part,
        state: 'approval-responded',
        approval: {
          ...part.approval,
          approved,
          reason: approved ? 'Approved by the customer on screen.' : 'Declined by the customer on screen.',
        },
      } as unknown as UIMessage['parts'][number];
    }),
  };
}
