// Decides when queued customer messages are sent to the agent.
//
// Rules:
//   - Messages the customer sends go into a queue; the input box never locks.
//   - The queue is sent once the customer has been quiet (no new message and
//     no typing) for `quietMs`. Each new message or keystroke restarts the wait.
//   - Nothing is sent while a run is in progress. When the run ends, anything
//     queued meanwhile follows the same quiet-window rule.
//   - Everything queued goes out together as one batch.
//   - Nothing is sent while the customer still has to answer an approval card
//     ("blocked"). Their answer starts its own run.
//
// Framework-free so it can be unit-tested with fake timers. The React hook in
// hooks/use-queued-chat.ts drives it.

export const QUIET_WINDOW_MS = 3000;

export interface QueuedMessage {
  id: string;
  text: string;
}

export interface SchedulerState {
  pending: QueuedMessage[];
  running: boolean;
  blocked: boolean;
  // When the queue will be sent, if a send is scheduled.
  sendAt: number | null;
}

export interface DispatchSchedulerOptions {
  quietMs?: number;
  onDispatch: (messages: QueuedMessage[]) => void;
  now?: () => number;
}

export class DispatchScheduler {
  private pending: QueuedMessage[] = [];
  private running = false;
  private blocked = false;
  private lastActivityAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sendAt: number | null = null;
  private listeners = new Set<(state: SchedulerState) => void>();
  private nextId = 1;
  private readonly quietMs: number;
  private readonly now: () => number;

  constructor(private readonly options: DispatchSchedulerOptions) {
    this.quietMs = options.quietMs ?? QUIET_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  enqueue(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.pending.push({ id: `q${this.nextId++}`, text: trimmed });
    this.lastActivityAt = this.now();
    this.schedule();
  }

  // Call on every keystroke. Only matters while something is queued.
  noteTyping(): void {
    if (this.pending.length === 0) return;
    this.lastActivityAt = this.now();
    this.schedule();
  }

  // A run started outside the queue, for example after an approval answer.
  runStarted(): void {
    this.running = true;
    this.schedule();
  }

  runFinished(): void {
    this.running = false;
    this.schedule();
  }

  // Holds the queue while an approval card is waiting for the customer.
  setBlocked(blocked: boolean): void {
    if (this.blocked === blocked) return;
    this.blocked = blocked;
    this.schedule();
  }

  getState(): SchedulerState {
    return { pending: [...this.pending], running: this.running, blocked: this.blocked, sendAt: this.sendAt };
  }

  subscribe(listener: (state: SchedulerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.clearTimer();
    this.listeners.clear();
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.running && !this.blocked && this.pending.length > 0) {
      const wait = Math.max(0, this.lastActivityAt + this.quietMs - this.now());
      this.sendAt = this.now() + wait;
      this.timer = setTimeout(() => this.fire(), wait);
    }
    this.emit();
  }

  private fire(): void {
    this.timer = null;
    this.sendAt = null;
    if (this.running || this.blocked || this.pending.length === 0) return this.emit();
    const batch = this.pending.splice(0);
    this.running = true;
    this.emit();
    this.options.onDispatch(batch);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sendAt = null;
  }

  private emit(): void {
    const state = this.getState();
    for (const l of this.listeners) l(state);
  }
}

export function joinBatch(messages: QueuedMessage[]): string {
  return messages.map((m) => m.text).join('\n');
}
