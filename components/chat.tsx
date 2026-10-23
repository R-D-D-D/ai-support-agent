'use client';

import { useEffect, useRef, useState } from 'react';
import { ToolCard } from '@/components/tool-card';
import { useQueuedChat } from '@/hooks/use-queued-chat';
import { cx } from '@/lib/format';
import type { FaultConfig } from '@/lib/types';

const SUGGESTIONS = [
  'Where is my order?',
  'My order is really late, can I get a refund?',
  'My package says delivered but I never got it.',
];

// Renders **bold** and keeps line breaks. Enough for the agent's short replies.
function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <span className="whitespace-pre-wrap">
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p,
      )}
    </span>
  );
}

// The server sends errors as JSON; useChat passes the raw body as the message.
function readableError(error: Error): string {
  try {
    const body = JSON.parse(error.message);
    if (body?.message) return body.message;
  } catch {
    // not JSON
  }
  return error.message || 'Something went wrong.';
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // Refresh immediately; the stored time may be from long before the countdown started.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function Chat(props: {
  customerName: string;
  getFaultConfig: () => FaultConfig;
  activeFaults: FaultConfig;
  onRunFinished: () => void;
}) {
  const chat = useQueuedChat({ getFaultConfig: props.getFaultConfig, onRunFinished: props.onRunFinished });
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const now = useNow(chat.sendAt !== null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat.messages, chat.pending.length, chat.status]);

  function submit(text: string) {
    if (!text.trim()) return;
    chat.clearError();
    chat.enqueue(text);
    setInput('');
  }

  const faultsOn = Object.entries(props.activeFaults).filter(([, m]) => m && m !== 'none');
  const secondsLeft = chat.sendAt ? Math.max(0, Math.ceil((chat.sendAt - now) / 1000)) : null;

  return (
    <section className="flex flex-col min-h-0 bg-white lg:border-r border-gray-200">
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-4">
        {chat.messages.length === 0 && chat.pending.length === 0 && (
          <div className="text-sm text-gray-500 mt-8 max-w-md">
            <p className="mb-3">
              Hi {props.customerName.split(' ')[0]}! I can check your orders and deliveries, and sort out
              refunds for late or missing packages.
            </p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => submit(s)}
                  className="rounded-full border border-gray-300 px-3 py-1 text-gray-700 hover:bg-gray-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {chat.messages.map((m) => (
          <div key={m.id} className={cx('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div
              className={cx(
                'max-w-[85%] text-sm',
                m.role === 'user'
                  ? 'rounded-2xl rounded-br-sm bg-indigo-600 text-white px-4 py-2'
                  : 'w-full text-gray-900',
              )}
            >
              {m.parts.map((part, i) => {
                if (part.type === 'text') return <RichText key={i} text={part.text} />;
                if (part.type.startsWith('tool-')) {
                  return <ToolCard key={i} part={part as unknown as Parameters<typeof ToolCard>[0]['part']} />;
                }
                return null;
              })}
            </div>
          </div>
        ))}

        {chat.status === 'submitted' && <div className="text-sm text-gray-400">Assistant is thinking…</div>}

        {chat.pending.map((q) => (
          <div key={q.id} className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-dashed border-indigo-300 bg-indigo-50 text-indigo-900 px-4 py-2 text-sm">
              <span className="whitespace-pre-wrap">{q.text}</span>
              <div className="text-[11px] text-indigo-500 mt-1">
                {chat.busy ? 'Queued until the assistant finishes' : 'Queued'}
              </div>
            </div>
          </div>
        ))}

        {chat.error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {readableError(chat.error)}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-gray-200 px-4 sm:px-6 py-3">
        <div className="h-5 text-xs text-gray-500 mb-1">
          {chat.busy && chat.status !== 'ready' ? 'Assistant is working. You can keep typing; new messages will queue.' : null}
          {!chat.busy && secondsLeft !== null && `Sending in ${secondsLeft}s… keep typing to add more.`}
        </div>
        {faultsOn.length > 0 && (
          <div className="text-xs text-amber-700 mb-1">
            Fault injection on: {faultsOn.map(([s, m]) => `${s}=${m}`).join(', ')}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
          className="flex gap-2"
        >
          <textarea
            value={input}
            rows={1}
            maxLength={2000}
            placeholder="Ask about an order…"
            onChange={(e) => {
              setInput(e.target.value);
              chat.noteTyping();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit(input);
              }
            }}
            className="flex-1 resize-none rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            type="submit"
            className="rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Send
          </button>
        </form>
      </div>
    </section>
  );
}
