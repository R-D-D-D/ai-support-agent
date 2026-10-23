// Company refund policy as a pure function. The agent never decides refund
// eligibility on its own: it calls a tool that runs this function, and the
// refund tool runs it again before any money moves.

import type { Order, Shipment } from '@/lib/types';

export const POLICY = {
  // A not-yet-delivered order qualifies once it is MORE than this many days
  // past its estimated delivery date.
  DELAY_GRACE_DAYS: 5,
  // A "delivered but not received" report must arrive within this many days
  // of the carrier's delivery scan.
  MISSING_REPORT_WINDOW_DAYS: 7,
  // Eligible orders below this total are refunded automatically. Orders at or
  // above it go to a human.
  AUTO_REFUND_CAP: 100,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ClaimType = 'delayed' | 'missing';

export type PolicyAction = 'auto_refund' | 'escalate' | 'deny' | 'already_handled';

export interface PolicyInput {
  order: Pick<Order, 'id' | 'total' | 'status'>;
  shipment: Pick<Shipment, 'status' | 'estimatedDelivery' | 'deliveredAt'>;
  claim: ClaimType;
  now: Date;
  hasRefund: boolean;
  hasOpenTicket: boolean;
}

export interface PolicyDecision {
  eligible: boolean;
  action: PolicyAction;
  reason: string;
  // Amount that would be refunded. Always the stored order total.
  refundAmount: number | null;
  // Set when a delayed order is not eligible yet.
  eligibleFrom: string | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function checkRefundEligibility(input: PolicyInput): PolicyDecision {
  const { order, shipment, claim, now } = input;

  if (input.hasRefund) {
    return deny('already_handled', 'A refund has already been issued for this order.');
  }
  if (input.hasOpenTicket) {
    return deny(
      'already_handled',
      'This order already has an open ticket with our support team.',
    );
  }
  if (order.status === 'cancelled') {
    return deny('deny', 'The order was cancelled, so there is nothing to refund.');
  }

  const delivered = shipment.status === 'delivered' && shipment.deliveredAt !== null;

  if (claim === 'delayed') {
    if (delivered) {
      return deny(
        'deny',
        'The carrier shows this order as delivered. If it did not arrive, it should be reported as missing instead.',
      );
    }
    const eta = new Date(shipment.estimatedDelivery);
    const daysLate = (now.getTime() - eta.getTime()) / DAY_MS;
    if (daysLate > POLICY.DELAY_GRACE_DAYS) {
      return eligible(
        order.total,
        `The order is ${round1(daysLate)} days past its estimated delivery date, which is more than the ${POLICY.DELAY_GRACE_DAYS}-day grace period.`,
      );
    }
    const eligibleFrom = new Date(eta.getTime() + POLICY.DELAY_GRACE_DAYS * DAY_MS);
    const lateText =
      daysLate > 0 ? `${round1(daysLate)} days late` : 'not yet past its estimated delivery date';
    return {
      ...deny(
        'deny',
        `The order is ${lateText}. Delay refunds apply only after more than ${POLICY.DELAY_GRACE_DAYS} days past the estimated delivery date.`,
      ),
      eligibleFrom: eligibleFrom.toISOString(),
    };
  }

  // claim === 'missing'
  if (!delivered) {
    return deny(
      'deny',
      'The carrier has not marked this order as delivered yet, so it is still in transit. Delay rules apply instead.',
    );
  }
  const daysSinceDelivery = (now.getTime() - new Date(shipment.deliveredAt!).getTime()) / DAY_MS;
  if (daysSinceDelivery <= POLICY.MISSING_REPORT_WINDOW_DAYS) {
    return eligible(
      order.total,
      `The carrier marked the order delivered ${round1(daysSinceDelivery)} days ago, within the ${POLICY.MISSING_REPORT_WINDOW_DAYS}-day window for missing-package reports.`,
    );
  }
  return deny(
    'deny',
    `The carrier marked the order delivered ${round1(daysSinceDelivery)} days ago. Missing-package reports must be made within ${POLICY.MISSING_REPORT_WINDOW_DAYS} days.`,
  );
}

function eligible(total: number, why: string): PolicyDecision {
  if (total < POLICY.AUTO_REFUND_CAP) {
    return {
      eligible: true,
      action: 'auto_refund',
      reason: `${why} The total is under $${POLICY.AUTO_REFUND_CAP}, so it can be refunded right away.`,
      refundAmount: total,
      eligibleFrom: null,
    };
  }
  return {
    eligible: true,
    action: 'escalate',
    reason: `${why} The total is $${POLICY.AUTO_REFUND_CAP} or more, so a human agent must approve the refund.`,
    refundAmount: total,
    eligibleFrom: null,
  };
}

function deny(action: 'deny' | 'already_handled', reason: string): PolicyDecision {
  return { eligible: false, action, reason, refundAmount: null, eligibleFrom: null };
}
