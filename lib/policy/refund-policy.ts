// Company refund policy as a pure function. The agent never decides refund
// eligibility on its own: it calls a tool that runs this function, and every
// tool that changes data runs it again before acting.
//
// Possible decisions:
//   bot_refund      the bot may refund, after the customer approves on screen
//   staff_review    a refund is justified, but a staff member must approve it
//   deny            not refundable (yet); eligibleFrom says when, if relevant
//   already_handled a refund or a pending refund request already exists

import type { Order, Shipment } from '@/lib/types';

export const POLICY = {
  // The bot may only refund orders whose total is below this amount.
  BOT_REFUND_LIMIT: 50,
  // A not-yet-delivered order qualifies once it is at least this many days
  // past its estimated delivery date.
  DELAY_THRESHOLD_DAYS: 14,
  // The bot refunds a late order only if the carrier has not scanned it for at
  // least this many days. A recent scan means the package may still arrive.
  STALLED_SCAN_DAYS: 7,
  // A "delivered but not received" report must arrive within this many days
  // of the carrier's delivery scan. These always go to staff.
  MISSING_REPORT_WINDOW_DAYS: 7,
  // The bot refunds only orders placed within this many days.
  MAX_ORDER_AGE_DAYS: 60,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ClaimType = 'delayed' | 'missing';

export type PolicyAction = 'bot_refund' | 'staff_review' | 'deny' | 'already_handled';

export interface PolicyInput {
  order: Pick<Order, 'id' | 'total' | 'status' | 'placedAt' | 'riskFlag' | 'paymentStatus'>;
  shipment: Pick<Shipment, 'status' | 'estimatedDelivery' | 'deliveredAt' | 'events'>;
  claim: ClaimType;
  now: Date;
  hasRefund: boolean;
  hasPendingRequest: boolean;
  // Store-wide limits on bot refunds.
  botRefunds: { enabled: boolean; remainingBudget: number };
}

export interface PolicyDecision {
  eligible: boolean;
  action: PolicyAction;
  reason: string;
  // Amount that would be refunded. Always the stored order total.
  refundAmount: number | null;
  // Set when a delayed order is not late enough yet.
  eligibleFrom: string | null;
  // Why the bot cannot refund an eligible order itself. Worded so it is safe
  // to show the customer.
  staffReviewReasons: string[];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function checkRefundEligibility(input: PolicyInput): PolicyDecision {
  const { order, shipment, claim, now } = input;

  if (input.hasRefund) {
    return decline('already_handled', 'A refund has already been issued for this order.');
  }
  if (input.hasPendingRequest) {
    return decline(
      'already_handled',
      'A refund request for this order is already waiting for our support team.',
    );
  }
  if (order.status === 'cancelled') {
    return decline('deny', 'The order was cancelled, so there is nothing to refund.');
  }

  const delivered = shipment.status === 'delivered' && shipment.deliveredAt !== null;
  let why: string;

  if (claim === 'delayed') {
    if (delivered) {
      return decline(
        'deny',
        'The carrier shows this order as delivered. If it did not arrive, it should be reported as missing instead.',
      );
    }
    const eta = new Date(shipment.estimatedDelivery);
    const daysLate = (now.getTime() - eta.getTime()) / DAY_MS;
    if (daysLate < POLICY.DELAY_THRESHOLD_DAYS) {
      const eligibleFrom = new Date(eta.getTime() + POLICY.DELAY_THRESHOLD_DAYS * DAY_MS);
      const lateText =
        daysLate > 0 ? `${round1(daysLate)} days late` : 'not yet past its estimated delivery date';
      return {
        ...decline(
          'deny',
          `The order is ${lateText}. Late-delivery refunds apply from ${POLICY.DELAY_THRESHOLD_DAYS} days past the estimated delivery date.`,
        ),
        eligibleFrom: eligibleFrom.toISOString(),
      };
    }
    why = `The order is ${round1(daysLate)} days past its estimated delivery date.`;
  } else {
    if (!delivered) {
      return decline(
        'deny',
        'The carrier has not marked this order as delivered yet, so it is still in transit. Delay rules apply instead.',
      );
    }
    const daysSinceDelivery = (now.getTime() - new Date(shipment.deliveredAt!).getTime()) / DAY_MS;
    if (daysSinceDelivery > POLICY.MISSING_REPORT_WINDOW_DAYS) {
      return decline(
        'deny',
        `The carrier marked the order delivered ${round1(daysSinceDelivery)} days ago. Missing-package reports must be made within ${POLICY.MISSING_REPORT_WINDOW_DAYS} days.`,
      );
    }
    why = `The carrier marked the order delivered ${round1(daysSinceDelivery)} days ago and the customer reports it missing.`;
  }

  // A refund is justified. Now decide whether the bot may issue it itself.
  const reasons: string[] = [];
  if (claim === 'missing') {
    reasons.push('Missing-package claims are reviewed by our support team.');
  }
  if (order.total >= POLICY.BOT_REFUND_LIMIT) {
    reasons.push(`Refunds of $${POLICY.BOT_REFUND_LIMIT} or more are approved by our support team.`);
  }
  if (claim === 'delayed' && !trackingStalled(shipment, now)) {
    reasons.push(
      `The carrier scanned the package within the last ${POLICY.STALLED_SCAN_DAYS} days, so it may still arrive.`,
    );
  }
  const orderAgeDays = (now.getTime() - new Date(order.placedAt).getTime()) / DAY_MS;
  if (orderAgeDays > POLICY.MAX_ORDER_AGE_DAYS) {
    reasons.push(`Orders placed more than ${POLICY.MAX_ORDER_AGE_DAYS} days ago are reviewed by our support team.`);
  }
  if (order.riskFlag) {
    // Deliberately vague: the customer must not learn about fraud flags.
    reasons.push('This order needs a manual check by our support team.');
  }
  if (order.paymentStatus !== 'settled') {
    reasons.push('The original payment has not settled yet.');
  }
  if (!input.botRefunds.enabled || input.botRefunds.remainingBudget < order.total) {
    reasons.push('Automatic refunds are paused right now.');
  }

  if (reasons.length === 0) {
    return {
      eligible: true,
      action: 'bot_refund',
      reason: `${why} It qualifies for a refund the assistant can issue once the customer approves it.`,
      refundAmount: order.total,
      eligibleFrom: null,
      staffReviewReasons: [],
    };
  }
  return {
    eligible: true,
    action: 'staff_review',
    reason: `${why} A refund is justified, but our support team must approve it.`,
    refundAmount: order.total,
    eligibleFrom: null,
    staffReviewReasons: reasons,
  };
}

// True when the carrier's most recent scan is at least STALLED_SCAN_DAYS old.
function trackingStalled(shipment: Pick<Shipment, 'events'>, now: Date): boolean {
  if (shipment.events.length === 0) return true;
  const lastScan = Math.max(...shipment.events.map((e) => new Date(e.at).getTime()));
  return now.getTime() - lastScan >= POLICY.STALLED_SCAN_DAYS * DAY_MS;
}

function decline(action: 'deny' | 'already_handled', reason: string): PolicyDecision {
  return {
    eligible: false,
    action,
    reason,
    refundAmount: null,
    eligibleFrom: null,
    staffReviewReasons: [],
  };
}
