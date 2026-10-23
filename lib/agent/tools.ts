// AI SDK tool definitions. Each tool only forwards its input to the gateway,
// which does all checking. See lib/gateway/tool-gateway.ts.

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
      description: 'Get items, totals, status, and any existing refund or open ticket for one order.',
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
        'Check company refund policy for a delayed or missing order. Returns the policy decision: auto_refund, escalate, deny, or already_handled. Always call this before issuing a refund or promising one.',
      inputSchema: TOOL_INPUTS.check_refund_eligibility,
      execute: (input) => gateway.call('check_refund_eligibility', input),
    }),
    issue_refund: tool({
      description:
        'Issue a full refund of the order total. Only works when the policy decision is auto_refund; the policy is re-checked on the server. Call at most once per turn.',
      inputSchema: TOOL_INPUTS.issue_refund,
      execute: (input) => gateway.call('issue_refund', input),
    }),
    escalate_to_human: tool({
      description:
        'Open a ticket for a human support specialist. Use when policy says escalate, when tools keep failing and the customer needs help, or when the customer asks for a person.',
      inputSchema: TOOL_INPUTS.escalate_to_human,
      execute: (input) => gateway.call('escalate_to_human', input),
    }),
  };
}

export type SupportTools = ReturnType<typeof buildTools>;
