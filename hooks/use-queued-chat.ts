'use client';

// useChat plus the message queue from lib/chat/dispatch-scheduler.ts: the
// customer can keep typing and sending while the agent works; queued messages
// go out together once the agent is done and the customer has been quiet for
// 3 seconds.
//
// Approval cards: when the agent wants to change data, the reply ends with a
// card. The customer's answer is sent automatically and starts a new run.
// Queued messages wait until every card is answered.

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DispatchScheduler,
  joinBatch,
  type SchedulerState,
} from '@/lib/chat/dispatch-scheduler';
import type { FaultConfig } from '@/lib/types';

function hasOpenApproval(messages: UIMessage[]): boolean {
  const last = messages.at(-1);
  return (
    last?.role === 'assistant' &&
    last.parts.some((p) => p.type.startsWith('tool-') && (p as { state?: string }).state === 'approval-requested')
  );
}

export function useQueuedChat(options: {
  getFaultConfig: () => FaultConfig;
  onRunFinished?: () => void;
}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const schedulerRef = useRef<DispatchScheduler | null>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        // Send the current fault settings with every request, including the
        // ones that carry an approval answer.
        body: () => ({ faultConfig: optionsRef.current.getFaultConfig() }),
      }),
    [],
  );

  const chat = useChat({
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => {
      schedulerRef.current?.runFinished();
      optionsRef.current.onRunFinished?.();
    },
    onError: () => {
      schedulerRef.current?.runFinished();
      optionsRef.current.onRunFinished?.();
    },
  });

  const sendRef = useRef(chat.sendMessage);
  sendRef.current = chat.sendMessage;

  const [state, setState] = useState<SchedulerState>({ pending: [], running: false, blocked: false, sendAt: null });

  useEffect(() => {
    const scheduler = new DispatchScheduler({
      onDispatch: (batch) => {
        void sendRef.current({ text: joinBatch(batch) });
      },
    });
    schedulerRef.current = scheduler;
    const unsubscribe = scheduler.subscribe(setState);
    return () => {
      unsubscribe();
      scheduler.dispose();
      schedulerRef.current = null;
    };
  }, []);

  // Runs started by an approval answer bypass the queue, so tell it.
  useEffect(() => {
    if (chat.status === 'submitted' || chat.status === 'streaming') schedulerRef.current?.runStarted();
  }, [chat.status]);

  const awaitingApproval = chat.status === 'ready' && hasOpenApproval(chat.messages);
  useEffect(() => {
    schedulerRef.current?.setBlocked(awaitingApproval);
  }, [awaitingApproval]);

  const busy = state.running || chat.status === 'submitted' || chat.status === 'streaming';

  return {
    messages: chat.messages,
    status: chat.status,
    error: chat.error,
    clearError: chat.clearError,
    pending: state.pending,
    sendAt: state.sendAt,
    busy,
    awaitingApproval,
    respondToApproval: (id: string, approved: boolean) =>
      chat.addToolApprovalResponse({
        id,
        approved,
        reason: approved ? 'Approved by the customer on screen.' : 'Declined by the customer on screen.',
      }),
    enqueue: (text: string) => schedulerRef.current?.enqueue(text),
    noteTyping: () => schedulerRef.current?.noteTyping(),
  };
}
