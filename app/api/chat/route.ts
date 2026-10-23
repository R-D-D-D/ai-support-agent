// Chat endpoint. See lib/agent/chat-handler.ts.

import { handleChat } from '@/lib/agent/chat-handler';

export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  return handleChat(req);
}
