import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatchScheduler, joinBatch, type QueuedMessage } from '@/lib/chat/dispatch-scheduler';

let sent: string[][];
let scheduler: DispatchScheduler;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  scheduler = new DispatchScheduler({
    quietMs: 3000,
    now: () => Date.now(),
    onDispatch: (batch: QueuedMessage[]) => sent.push(batch.map((m) => m.text)),
  });
});

afterEach(() => {
  scheduler.dispose();
  vi.useRealTimers();
});

describe('dispatch scheduler', () => {
  it('sends a single message after 3 quiet seconds', () => {
    scheduler.enqueue('hello');
    vi.advanceTimersByTime(2999);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([['hello']]);
  });

  it('restarts the wait on each new message and batches them', () => {
    scheduler.enqueue('my order');
    vi.advanceTimersByTime(2000);
    scheduler.enqueue('is late');
    vi.advanceTimersByTime(2999);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([['my order', 'is late']]);
  });

  it('restarts the wait while the customer is typing', () => {
    scheduler.enqueue('hi');
    vi.advanceTimersByTime(2500);
    scheduler.noteTyping();
    vi.advanceTimersByTime(2500);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([['hi']]);
  });

  it('ignores typing when nothing is queued', () => {
    scheduler.noteTyping();
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
  });

  it('never sends while a run is in progress', () => {
    scheduler.enqueue('first');
    vi.advanceTimersByTime(3000);
    expect(sent).toHaveLength(1);

    scheduler.enqueue('second');
    vi.advanceTimersByTime(20_000);
    expect(sent).toHaveLength(1);
    expect(scheduler.getState().pending.map((m) => m.text)).toEqual(['second']);
  });

  it('sends what was queued during a run once the run finishes', () => {
    scheduler.enqueue('first');
    vi.advanceTimersByTime(3000);
    scheduler.enqueue('second');
    scheduler.enqueue('third');
    vi.advanceTimersByTime(5000); // the quiet window has already passed
    scheduler.runFinished();
    vi.advanceTimersByTime(0);
    expect(sent).toEqual([['first'], ['second', 'third']]);
  });

  it('still waits out the quiet window if the run ends right after a message', () => {
    scheduler.enqueue('first');
    vi.advanceTimersByTime(3000);
    scheduler.enqueue('second');
    vi.advanceTimersByTime(1000);
    scheduler.runFinished();
    vi.advanceTimersByTime(1999);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([['first'], ['second']]);
  });

  it('ignores blank messages', () => {
    scheduler.enqueue('   ');
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
  });

  it('joins a batch with new lines', () => {
    expect(joinBatch([{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }])).toBe('one\ntwo');
  });
});
