import { describe, expect, it } from 'vitest';
import { checkRefundEligibility, type PolicyInput } from '@/lib/policy/refund-policy';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-24T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

// A late order that passes every bot check by default.
function delayed(overrides: {
  daysLate?: number;
  total?: number;
  lastScanDaysAgo?: number;
  placedDaysAgo?: number;
  riskFlag?: boolean;
  paymentStatus?: 'settled' | 'pending';
  enabled?: boolean;
  remainingBudget?: number;
} = {}): PolicyInput {
  const o = {
    daysLate: 16,
    total: 45,
    lastScanDaysAgo: 10,
    placedDaysAgo: 25,
    riskFlag: false,
    paymentStatus: 'settled' as const,
    enabled: true,
    remainingBudget: 500,
    ...overrides,
  };
  return {
    order: { id: 'ORD-1', total: o.total, status: 'shipped', placedAt: daysAgo(o.placedDaysAgo), riskFlag: o.riskFlag, paymentStatus: o.paymentStatus },
    shipment: {
      status: 'in_transit',
      estimatedDelivery: daysAgo(o.daysLate),
      deliveredAt: null,
      events: [{ at: daysAgo(o.lastScanDaysAgo), location: 'Hub', description: 'In transit' }],
    },
    claim: 'delayed',
    now: NOW,
    hasRefund: false,
    hasPendingRequest: false,
    botRefunds: { enabled: o.enabled, remainingBudget: o.remainingBudget },
  };
}

function missing(daysSinceDelivery: number, total = 45): PolicyInput {
  return {
    ...delayed({ total }),
    order: { id: 'ORD-1', total, status: 'delivered', placedAt: daysAgo(10), riskFlag: false, paymentStatus: 'settled' },
    shipment: {
      status: 'delivered',
      estimatedDelivery: daysAgo(daysSinceDelivery + 1),
      deliveredAt: daysAgo(daysSinceDelivery),
      events: [{ at: daysAgo(daysSinceDelivery), location: 'Door', description: 'Delivered' }],
    },
    claim: 'missing',
  };
}

describe('late-delivery threshold', () => {
  it('denies at 13 days late and says when it becomes eligible', () => {
    const d = checkRefundEligibility(delayed({ daysLate: 13 }));
    expect(d.action).toBe('deny');
    expect(d.eligibleFrom).toBe(new Date(NOW.getTime() + 1 * DAY).toISOString());
  });

  it('allows a bot refund at exactly 14 days late', () => {
    const d = checkRefundEligibility(delayed({ daysLate: 14 }));
    expect(d.action).toBe('bot_refund');
    expect(d.refundAmount).toBe(45);
  });

  it('denies a delayed claim when the carrier says delivered', () => {
    const d = checkRefundEligibility({ ...missing(1), claim: 'delayed' });
    expect(d.action).toBe('deny');
    expect(d.reason).toMatch(/missing/);
  });
});

describe('what the bot may refund itself', () => {
  it('lets the bot refund $49.99', () => {
    expect(checkRefundEligibility(delayed({ total: 49.99 })).action).toBe('bot_refund');
  });

  it('sends $50.00 to staff', () => {
    const d = checkRefundEligibility(delayed({ total: 50 }));
    expect(d.action).toBe('staff_review');
    expect(d.eligible).toBe(true);
    expect(d.staffReviewReasons.join(' ')).toMatch(/\$50 or more/);
  });

  it('lets the bot refund when the last scan was exactly 7 days ago', () => {
    expect(checkRefundEligibility(delayed({ lastScanDaysAgo: 7 })).action).toBe('bot_refund');
  });

  it('sends a still-moving package to staff (scanned 6 days ago)', () => {
    const d = checkRefundEligibility(delayed({ lastScanDaysAgo: 6 }));
    expect(d.action).toBe('staff_review');
    expect(d.staffReviewReasons.join(' ')).toMatch(/may still arrive/);
  });

  it('sends orders placed more than 60 days ago to staff', () => {
    expect(checkRefundEligibility(delayed({ placedDaysAgo: 60 })).action).toBe('bot_refund');
    expect(checkRefundEligibility(delayed({ placedDaysAgo: 61 })).action).toBe('staff_review');
  });

  it('sends risk-flagged orders to staff without mentioning fraud', () => {
    const d = checkRefundEligibility(delayed({ riskFlag: true }));
    expect(d.action).toBe('staff_review');
    expect(JSON.stringify(d)).not.toMatch(/fraud/i);
  });

  it('sends orders with an unsettled payment to staff', () => {
    expect(checkRefundEligibility(delayed({ paymentStatus: 'pending' })).action).toBe('staff_review');
  });

  it('lists every reason when several checks fail', () => {
    const d = checkRefundEligibility(delayed({ total: 80, riskFlag: true, lastScanDaysAgo: 1 }));
    expect(d.staffReviewReasons).toHaveLength(3);
  });
});

describe('store-wide limits', () => {
  it('sends cases to staff when bot refunds are switched off', () => {
    const d = checkRefundEligibility(delayed({ enabled: false }));
    expect(d.action).toBe('staff_review');
    expect(d.staffReviewReasons).toContain('Automatic refunds are paused right now.');
  });

  it('sends cases to staff when the daily budget cannot cover the refund', () => {
    expect(checkRefundEligibility(delayed({ remainingBudget: 44.99 })).action).toBe('staff_review');
    expect(checkRefundEligibility(delayed({ remainingBudget: 45 })).action).toBe('bot_refund');
  });
});

describe('missing packages', () => {
  it('always go to staff, even under $50', () => {
    const d = checkRefundEligibility(missing(2, 20));
    expect(d.action).toBe('staff_review');
    expect(d.staffReviewReasons.join(' ')).toMatch(/Missing-package/);
  });

  it('are reviewable on day 7 after delivery', () => {
    expect(checkRefundEligibility(missing(7)).action).toBe('staff_review');
  });

  it('are denied on day 8 after delivery', () => {
    expect(checkRefundEligibility(missing(8)).action).toBe('deny');
  });

  it('are denied when the package is not marked delivered', () => {
    expect(checkRefundEligibility({ ...delayed(), claim: 'missing' }).action).toBe('deny');
  });
});

describe('already handled', () => {
  it('does not refund twice', () => {
    expect(checkRefundEligibility({ ...delayed(), hasRefund: true }).action).toBe('already_handled');
  });

  it('does not file a second request while one is pending', () => {
    expect(checkRefundEligibility({ ...missing(2), hasPendingRequest: true }).action).toBe('already_handled');
  });

  it('denies a cancelled order', () => {
    const input = delayed();
    expect(checkRefundEligibility({ ...input, order: { ...input.order, status: 'cancelled' } }).action).toBe('deny');
  });
});
