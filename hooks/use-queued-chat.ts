'use client';

// useChat plus the message queue from lib/chat/dispatch-scheduler.ts: the
// customer can keep typing and sending while the agent works; queued messages
// go out together once the agent is done and the customer has been quiet for
// 3 seconds.

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DispatchScheduler,
  joinBatch,
  type SchedulerState,
} from '@/lib/chat/dispatch-scheduler';
import type { FaultConfig } from '@/lib/types';

export function useQueuedChat(options: {
  getFaultConfig: () => FaultConfig;
  onRunFinished?: () => void;
}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const schedulerRef = useRef<DispatchScheduler | null>(null);

  const transport = useMemo(() => new DefaultChatTransport({ api: '/api/chat' }), []);

  const chat = useChat({
    transport,
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

  const [state, setState] = useState<SchedulerState>({ pending: [], running: false, sendAt: null });

  useEffect(() => {
    const scheduler = new DispatchScheduler({
      onDispatch: (batch) => {
        void sendRef.current(
          { text: joinBatch(batch) },
          { body: { faultConfig: optionsRef.current.getFaultConfig() } },
        );
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

  const busy = state.running || chat.status === 'submitted' || chat.status === 'streaming';

  return {
    messages: chat.messages,
    status: chat.status,
    error: chat.error,
    clearError: chat.clearError,
    pending: state.pending,
    sendAt: state.sendAt,
    busy,
    enqueue: (text: string) => schedulerRef.current?.enqueue(text),
    noteTyping: () => schedulerRef.current?.noteTyping(),
  };
}
