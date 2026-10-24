// Settings for actions that change data. Read on every call so they can be
// changed without a restart in tests.

// Turns refunds by the bot on or off. Set BOT_REFUNDS_ENABLED=false to stop
// them instantly; eligible cases then go to the staff queue.
export function botRefundsEnabled(): boolean {
  return process.env.BOT_REFUNDS_ENABLED !== 'false';
}

// Total the bot may refund per calendar day (UTC), across all customers.
export function botDailyRefundBudget(): number {
  const value = Number(process.env.BOT_DAILY_REFUND_BUDGET ?? 500);
  return Number.isFinite(value) && value >= 0 ? value : 500;
}

// Most tickets one customer can open in any 24 hours.
export const TICKETS_PER_CUSTOMER_PER_DAY = 3;

// How long a customer has to approve an action shown in the chat.
export const APPROVAL_TTL_MS = 10 * 60 * 1000;
