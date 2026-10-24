// AI SDK tool definitions. Each tool only forwards its input to the gateway,
// which does all checking. See lib/gateway/tool-gateway.ts.
//
// issue_refund, request_staff_refund, and escalate_to_human change data. The
// agent (lib/agent/support-agent.ts) makes them wait for the customer's
// approval, and the gateway refuses them without a recorded approval.

import { tool } from 'ai';
import { TOOL_INPUTS, type Gateway } from '@/lib/gateway/tool-gateway';

export function buildTools(gateway: Gateway) {
  return {
    list_my_orders: tool({
      description: "List the signed-in customer's orders with status and totals.",
      inputSchema: TOOL_INPUTS.list_my_orders,
      execute: (input) => gateway.call('list_my_orders', input),
    }),
    get_order_details: tool({
      description:
        'Get items, totals, status, and any refund, refund request (with the staff decision), or open ticket for one order.',
      inputSchema: TOOL_INPUTS.get_order_details,
      execute: (input) => gateway.call('get_order_details', input),
    }),
    get_shipment_tracking: tool({
      description: 'Get carrier tracking for one order: status, estimated delivery, delivery time, and scan history.',
      inputSchema: TOOL_INPUTS.get_shipment_tracking,
      execute: (input) => gateway.call('get_shipment_tracking', input),
    }),
    check_refund_eligibility: tool({
      description:
        'Check company refund policy for a delayed or missing order. Returns bot_refund, staff_review, deny, or already_handled. Always call this before issue_refund or request_staff_refund.',
      inputSchema: TOOL_INPUTS.check_refund_eligibility,
      execute: (input) => gateway.call('check_refund_eligibility', input),
    }),
    issue_refund: tool({
      description:
        'Refund the order total, only when the policy decision is bot_refund. The customer is asked to approve on screen before it runs.',
      inputSchema: TOOL_INPUTS.issue_refund,
      execute: (input, { toolCallId }) => gateway.call('issue_refund', input, { toolCallId }),
    }),
    request_staff_refund: tool({
      description:
        'Send a refund request to the support team, only when the policy decision is staff_review. The customer is asked to approve on screen before it is filed.',
      inputSchema: TOOL_INPUTS.request_staff_refund,
      execute: (input, { toolCallId }) => gateway.call('request_staff_refund', input, { toolCallId }),
    }),
    escalate_to_human: tool({
      description:
        'Open a ticket for a human support specialist, when tools keep failing or the customer asks for a person. Not for refunds: use request_staff_refund. The customer is asked to approve on screen first.',
      inputSchema: TOOL_INPUTS.escalate_to_human,
      execute: (input, { toolCallId }) => gateway.call('escalate_to_human', input, { toolCallId }),
    }),
  };
}

export type SupportTools = ReturnType<typeof buildTools>;
