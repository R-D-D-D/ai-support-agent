import { describe, expect, it } from 'vitest';
import { checkRefundEligibility, type PolicyInput } from '@/lib/policy/refund-policy';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-23T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

function delayed(daysLate: number, total = 45): PolicyInput {
  return {
    order: { id: 'ORD-1', total, status: 'shipped' },
    shipment: { status: 'in_transit', estimatedDelivery: daysAgo(daysLate), deliveredAt: null },
    claim: 'delayed',
    now: NOW,
    hasRefund: false,
    hasOpenTicket: false,
  };
}

function missing(daysSinceDelivery: number, total = 45): PolicyInput {
  return {
    order: { id: 'ORD-1', total, status: 'delivered' },
    shipment: {
      status: 'delivered',
      estimatedDelivery: daysAgo(daysSinceDelivery + 1),
      deliveredAt: daysAgo(daysSinceDelivery),
    },
    claim: 'missing',
    now: NOW,
    hasRefund: false,
    hasOpenTicket: false,
  };
}

describe('delayed orders', () => {
  it('is not eligible at exactly 5 days late', () => {
    const d = checkRefundEligibility(delayed(5));
    expect(d.action).toBe('deny');
    expect(d.eligibleFrom).toBe(NOW.toISOString());
  });

  it('is eligible at 6 days late', () => {
    const d = checkRefundEligibility(delayed(6));
    expect(d.action).toBe('auto_refund');
    expect(d.refundAmount).toBe(45);
  });

  it('is not eligible at 2 days late and says when it will be', () => {
    const d = checkRefundEligibility(delayed(2));
    expect(d.eligible).toBe(false);
    expect(d.eligibleFrom).toBe(new Date(NOW.getTime() + 3 * DAY).toISOString());
  });

  it('is denied when the carrier says it was delivered', () => {
    const input = missing(1);
    const d = checkRefundEligibility({ ...input, claim: 'delayed' });
    expect(d.action).toBe('deny');
    expect(d.reason).toMatch(/missing/);
  });
});

describe('auto-refund cap', () => {
  it('auto-refunds $99.99', () => {
    expect(checkRefundEligibility(delayed(8, 99.99)).action).toBe('auto_refund');
  });

  it('escalates $100.00', () => {
    const d = checkRefundEligibility(delayed(8, 100));
    expect(d.eligible).toBe(true);
    expect(d.action).toBe('escalate');
  });
});

describe('missing packages', () => {
  it('is eligible on day 7 after delivery', () => {
    expect(checkRefundEligibility(missing(7)).action).toBe('auto_refund');
  });

  it('is denied on day 8 after delivery', () => {
    expect(checkRefundEligibility(missing(8)).action).toBe('deny');
  });

  it('escalates a high-value missing package', () => {
    expect(checkRefundEligibility(missing(2, 240)).action).toBe('escalate');
  });

  it('is denied when the package is not marked delivered', () => {
    const d = checkRefundEligibility({ ...delayed(8), claim: 'missing' });
    expect(d.action).toBe('deny');
  });
});

describe('already handled', () => {
  it('does not refund twice', () => {
    const d = checkRefundEligibility({ ...delayed(8), hasRefund: true });
    expect(d.action).toBe('already_handled');
  });

  it('does not act on an order with an open ticket', () => {
    const d = checkRefundEligibility({ ...missing(2), hasOpenTicket: true });
    expect(d.action).toBe('already_handled');
  });

  it('denies a cancelled order', () => {
    const input = delayed(8);
    const d = checkRefundEligibility({ ...input, order: { ...input.order, status: 'cancelled' } });
    expect(d.action).toBe('deny');
  });
});
