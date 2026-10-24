// Tool gateway. Every tool the agent can call goes through here.
//
// For each tool call, `call()`:
//   1. validates the input against the tool's schema,
//   2. checks that any order belongs to the signed-in customer (an order owned
//      by someone else is reported as "not found"),
//   3. for tools that change data, requires a matching customer approval that
//      the server itself recorded (see lib/agent/approvals.ts), and enforces
//      per-run limits,
//   4. calls the backend through safeCall (fault injection, timeout, retry,
//      response validation),
//   5. returns only allowlisted fields, with outside free text marked untrusted,
//   6. records the call in the run log.
//
// Tools that change data are issue_refund, request_staff_refund, and
// escalate_to_human. Before the customer sees an approval card for one of them,
// the agent's approval hook calls `requestApproval()`, which runs the same
// checks without changing anything and records what the customer is asked to
// approve. When the approved call comes back, `revalidateApproval()` checks the
// record still matches, and `call()` checks it again before acting.
//
// The customer id comes from the verified session when the gateway is created.
// No tool takes a customer id as input, so the model has nothing to forge.

import { z } from 'zod';
import {
  checkApproval,
  consumeApproval,
  recordApprovalRequest,
  type ApprovalTool,
} from '@/lib/agent/approvals';
import type { RunRecorder, ServiceCallRecord } from '@/lib/agent/run-log';
import { botDailyRefundBudget, botRefundsEnabled, TICKETS_PER_CUSTOMER_PER_DAY } from '@/lib/config';
import {
  orderDetailDto,
  orderSummaryDto,
  refundDto,
  refundRequestDto,
  shipmentDto,
  ticketDto,
} from '@/lib/gateway/dto';
import { safeCall, type SafeCallOptions } from '@/lib/gateway/safe-call';
import {
  createdRefundRequestSchema,
  createdRefundSchema,
  createdTicketSchema,
  orderSchema,
  refundRequestSchema,
  refundSchema,
  shipmentSchema,
  ticketSchema,
} from '@/lib/gateway/schemas';
import type { ToolError, ToolErrorCode, ToolResult } from '@/lib/gateway/types';
import { checkRefundEligibility, type ClaimType } from '@/lib/policy/refund-policy';
import * as ordersService from '@/lib/services/orders';
import * as refundRequestsService from '@/lib/services/refund-requests';
import * as refundsService from '@/lib/services/refunds';
import * as shipmentsService from '@/lib/services/shipments';
import * as ticketsService from '@/lib/services/tickets';
import type { FaultConfig, Order, ServiceName } from '@/lib/types';

// ---- Tool input schemas (shared with the AI SDK tool definitions) ----

const orderId = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^ORD-\d{4,8}$/, 'Order ids look like ORD-1234.')
  .describe('The order id, for example ORD-1001.');

const claim = z
  .enum(['delayed', 'missing'])
  .describe(
    "'delayed' if the order has not been delivered yet and is late. 'missing' if the carrier says it was delivered but the customer did not receive it.",
  );

export const TOOL_INPUTS = {
  list_my_orders: z.object({}),
  get_order_details: z.object({ orderId }),
  get_shipment_tracking: z.object({ orderId }),
  check_refund_eligibility: z.object({ orderId, claim }),
  issue_refund: z.object({ orderId, claim }),
  request_staff_refund: z.object({
    orderId,
    claim,
    note: z
      .string()
      .min(10)
      .max(500)
      .describe('Context for the support team: what the customer reported and what you checked.'),
  }),
  escalate_to_human: z.object({
    orderId: orderId.optional(),
    reason: z.enum(['missing_package', 'tool_failure', 'customer_request', 'other']),
    summary: z
      .string()
      .min(10)
      .max(1000)
      .describe('A short summary of the issue and what has been checked so far, for the human agent.'),
    priority: z.enum(['normal', 'high']).default('normal'),
  }),
} as const;

export type ToolName = keyof typeof TOOL_INPUTS;

// Tools that change data and therefore need the customer's approval.
export const APPROVAL_TOOLS: readonly ApprovalTool[] = [
  'issue_refund',
  'request_staff_refund',
  'escalate_to_human',
];

export function needsApproval(tool: string): tool is ApprovalTool {
  return (APPROVAL_TOOLS as readonly string[]).includes(tool);
}

// Limits on data-changing actions within one agent run.
export const RUN_LIMITS = { refunds: 1, refundRequests: 1, escalations: 1 } as const;

// What the approval hook tells the AI SDK. 'user-approval' shows the card;
// 'denied' refuses the call without showing one.
export type ApprovalDecision =
  | { type: 'user-approval'; reason: string }
  | { type: 'denied'; reason: string };

class GatewayFailure extends Error {
  constructor(readonly error: ToolError) {
    super(error.message);
  }
}

function fail(code: ToolErrorCode, message: string, retryable = false): never {
  throw new GatewayFailure({ code, message, retryable });
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export interface GatewayDeps {
  customerId: string;
  faultConfig?: FaultConfig;
  recorder?: RunRecorder;
  now?: () => Date;
  safeCallOptions?: Partial<SafeCallOptions>;
}

export type Gateway = ReturnType<typeof createGateway>;

export function createGateway(deps: GatewayDeps) {
  const now = deps.now ?? (() => new Date());
  const used = { refunds: 0, refundRequests: 0, escalations: 0 };

  // Helpers shared by tool calls and approval checks. `serviceCalls` collects
  // each backend call for the run log.
  function helpers(serviceCalls: ServiceCallRecord[]) {
    async function load<T>(
      service: ServiceName,
      schema: z.ZodType<T>,
      fn: () => Promise<unknown>,
    ): Promise<T> {
      const result = await safeCall({
        service,
        fault: deps.faultConfig?.[service] ?? 'none',
        schema,
        call: fn,
        options: deps.safeCallOptions,
      });
      serviceCalls.push({
        service,
        attempts: result.attempts,
        ok: result.ok,
        errorCode: result.ok ? undefined : result.error.code,
      });
      if (!result.ok) throw new GatewayFailure(result.error);
      return result.data;
    }

    // Loads an order and checks that it belongs to the signed-in customer.
    async function ownedOrder(id: string): Promise<Order> {
      const order = await load('orders', orderSchema.nullable(), () => ordersService.getOrder(id));
      if (!order || order.customerId !== deps.customerId) {
        // Same answer whether the order does not exist or belongs to someone
        // else, so the agent cannot confirm other customers' order ids.
        fail('not_found', `No order ${id} was found on this customer's account.`);
      }
      return order;
    }

    async function evaluate(id: string, claimType: ClaimType) {
      const order = await ownedOrder(id);
      const shipment = await load('shipments', shipmentSchema.nullable(), () =>
        shipmentsService.getShipmentForOrder(id),
      );
      if (!shipment) fail('not_found', `No shipment record exists for order ${id}.`);
      const refund = await load('refunds', refundSchema.nullable(), () =>
        refundsService.findRefundForOrder(id),
      );
      const pendingRequest = await load('refunds', refundRequestSchema.nullable(), () =>
        refundRequestsService.findPendingRequestForOrder(id),
      );
      const enabled = botRefundsEnabled();
      const decision = checkRefundEligibility({
        order,
        shipment,
        claim: claimType,
        now: now(),
        hasRefund: refund !== null,
        hasPendingRequest: pendingRequest !== null,
        botRefunds: {
          enabled,
          remainingBudget: enabled ? botDailyRefundBudget() - refundsService.botRefundedToday(now()) : 0,
        },
      });
      return { order, decision };
    }

    function checkTicketCap() {
      if (ticketsService.ticketsOpenedInLastDay(deps.customerId, now()) >= TICKETS_PER_CUSTOMER_PER_DAY) {
        fail(
          'limit_reached',
          `This customer has opened ${TICKETS_PER_CUSTOMER_PER_DAY} tickets in the last 24 hours, which is the limit. Existing tickets are still being handled.`,
        );
      }
    }

    // Resolves the order a ticket should be linked to. If the order service is
    // down, the ticket can still open, without a link we could not verify.
    async function ticketOrder(id: string | undefined, summary: string) {
      if (!id) return { orderId: null, summary };
      try {
        return { orderId: (await ownedOrder(id)).id, summary };
      } catch (err) {
        if (err instanceof GatewayFailure && err.error.retryable) {
          return {
            orderId: null,
            summary: `${summary}\n\n[Customer referenced order ${id}; ownership not verified because the order service was unavailable.]`,
          };
        }
        throw err;
      }
    }

    return { load, ownedOrder, evaluate, checkTicketCap, ticketOrder };
  }

  type Handlers = {
    [K in ToolName]: (
      args: z.output<(typeof TOOL_INPUTS)[K]>,
      h: ReturnType<typeof helpers>,
    ) => Promise<unknown>;
  };

  const handlers: Handlers = {
    list_my_orders: async (_args, h) => {
      const orders = await h.load('orders', z.array(orderSchema), () =>
        ordersService.listOrdersForCustomer(deps.customerId),
      );
      // Belt and braces: drop anything that is not this customer's.
      return { orders: orders.filter((o) => o.customerId === deps.customerId).map(orderSummaryDto) };
    },

    get_order_details: async ({ orderId: id }, h) => {
      const order = await h.ownedOrder(id);
      const refund = await h.load('refunds', refundSchema.nullable(), () =>
        refundsService.findRefundForOrder(id),
      );
      const request = await h.load('refunds', refundRequestSchema.nullable(), () =>
        refundRequestsService.findLatestRequestForOrder(id),
      );
      const ticket = await h.load('tickets', ticketSchema.nullable(), () =>
        ticketsService.findOpenTicketForOrder(id),
      );
      return orderDetailDto(order, refund, request, ticket);
    },

    get_shipment_tracking: async ({ orderId: id }, h) => {
      await h.ownedOrder(id);
      const shipment = await h.load('shipments', shipmentSchema.nullable(), () =>
        shipmentsService.getShipmentForOrder(id),
      );
      if (!shipment) fail('not_found', `No shipment record exists for order ${id}.`);
      return shipmentDto(shipment);
    },

    check_refund_eligibility: async ({ orderId: id, claim: claimType }, h) => {
      const { decision } = await h.evaluate(id, claimType);
      return { orderId: id, claim: claimType, ...decision };
    },

    issue_refund: async ({ orderId: id, claim: claimType }, h) => {
      return reserve('refunds', 'Only one refund can be issued per conversation turn.', async () => {
        // The policy is checked again here, whatever the model concluded
        // earlier. The amount always comes from the stored order total.
        const { order, decision } = await h.evaluate(id, claimType);
        if (decision.action !== 'bot_refund') {
          fail('not_eligible', `Refund refused by policy (${decision.action}): ${decision.reason}`);
        }
        // Safe to retry: createRefund is idempotent per order.
        const { refund, created } = await h.load('refunds', createdRefundSchema, () =>
          refundsService.createRefund({
            orderId: id,
            customerId: deps.customerId,
            amount: order.total,
            reason: decision.reason,
            issuedBy: 'bot',
          }),
        );
        return {
          ...refundDto(refund),
          alreadyExisted: !created,
          message: 'Refund issued to the original payment method. It usually appears within 5 to 10 business days.',
        };
      });
    },

    request_staff_refund: async ({ orderId: id, claim: claimType, note }, h) => {
      return reserve('refundRequests', 'Only one refund request can be filed per conversation turn.', async () => {
        const { order, decision } = await h.evaluate(id, claimType);
        if (decision.action !== 'staff_review') {
          fail(
            'not_eligible',
            decision.action === 'bot_refund'
              ? 'This order does not need staff review. Use issue_refund instead.'
              : `Refund request refused by policy (${decision.action}): ${decision.reason}`,
          );
        }
        const { request, created } = await h.load('refunds', createdRefundRequestSchema, () =>
          refundRequestsService.createRefundRequest({
            orderId: id,
            customerId: deps.customerId,
            amount: order.total,
            claim: claimType,
            reviewReasons: decision.staffReviewReasons,
            agentNote: note,
          }),
        );
        return {
          ...refundRequestDto(request),
          alreadyExisted: !created,
          message: 'Our support team will review this request. The decision will appear on the order.',
        };
      });
    },

    escalate_to_human: async ({ orderId: id, reason, summary, priority }, h) => {
      return reserve('escalations', 'A ticket was already opened in this conversation turn.', async () => {
        h.checkTicketCap();
        const target = await h.ticketOrder(id, summary);
        const { ticket, created } = await h.load('tickets', createdTicketSchema, () =>
          ticketsService.createTicket({
            orderId: target.orderId,
            customerId: deps.customerId,
            reason,
            summary: target.summary,
            priority,
          }),
        );
        return {
          ...ticketDto(ticket),
          alreadyExisted: !created,
          message: 'A support specialist will reply by email within 24 hours.',
        };
      });
    },
  };

  // Takes one slot of a per-run limit before any await, so two parallel calls
  // cannot both pass. The slot is given back if the action fails.
  async function reserve<T>(kind: keyof typeof used, limitMessage: string, fn: () => Promise<T>): Promise<T> {
    if (used[kind] >= RUN_LIMITS[kind]) fail('limit_reached', limitMessage);
    used[kind] += 1;
    try {
      return await fn();
    } catch (err) {
      used[kind] -= 1;
      throw err;
    }
  }

  function parse(toolName: ToolName, rawArgs: unknown) {
    const schema = TOOL_INPUTS[toolName];
    if (!schema) {
      return { ok: false as const, error: { code: 'invalid_input' as const, message: `Unknown tool ${String(toolName)}.`, retryable: false } };
    }
    const parsed = schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return { ok: false as const, error: { code: 'invalid_input' as const, message: z.prettifyError(parsed.error), retryable: false } };
    }
    return { ok: true as const, data: parsed.data };
  }

  function record(tool: string, rawArgs: unknown, result: ToolResult, serviceCalls: ServiceCallRecord[], startedAt: number) {
    deps.recorder?.recordToolCall({
      tool,
      input: rawArgs,
      ok: result.ok,
      output: result.ok ? result.data : undefined,
      error: result.ok ? undefined : result.error,
      serviceCalls,
      durationMs: Date.now() - startedAt,
      at: new Date(startedAt).toISOString(),
    });
  }

  async function call(
    toolName: ToolName,
    rawArgs: unknown,
    options: { toolCallId?: string } = {},
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    const serviceCalls: ServiceCallRecord[] = [];
    let result: ToolResult;

    const parsed = parse(toolName, rawArgs);
    if (!parsed.ok) {
      result = { ok: false, error: parsed.error };
    } else {
      try {
        if (needsApproval(toolName)) {
          // Never act without an approval the server itself recorded.
          const approval = checkApproval({
            toolCallId: options.toolCallId,
            customerId: deps.customerId,
            tool: toolName,
            input: parsed.data,
          });
          if (!approval.ok) fail('approval_required', approval.reason);
          if (!consumeApproval(approval.record.toolCallId)) {
            fail('approval_required', 'This approval has already been used.');
          }
        }
        const handler = handlers[toolName] as (args: unknown, h: ReturnType<typeof helpers>) => Promise<unknown>;
        result = { ok: true, data: await handler(parsed.data, helpers(serviceCalls)) };
      } catch (err) {
        result =
          err instanceof GatewayFailure
            ? { ok: false, error: err.error }
            : { ok: false, error: { code: 'internal_error', message: 'Unexpected internal error.', retryable: false } };
      }
    }

    record(String(toolName), rawArgs, result, serviceCalls, startedAt);
    return result;
  }

  // Runs before the customer sees an approval card. Checks the action would be
  // allowed right now, without changing anything, and records the approval
  // request. Returns 'denied' (no card is shown) when it is not allowed.
  async function requestApproval(
    toolName: ApprovalTool,
    rawArgs: unknown,
    toolCallId: string,
  ): Promise<ApprovalDecision> {
    const startedAt = Date.now();
    const serviceCalls: ServiceCallRecord[] = [];
    let decision: ApprovalDecision;

    const parsed = parse(toolName, rawArgs);
    if (!parsed.ok) {
      decision = { type: 'denied', reason: parsed.error.message };
    } else {
      try {
        const description = await describe(toolName, parsed.data, helpers(serviceCalls));
        recordApprovalRequest({
          toolCallId,
          customerId: deps.customerId,
          tool: toolName,
          input: parsed.data,
          description,
        });
        decision = { type: 'user-approval', reason: description };
      } catch (err) {
        decision = {
          type: 'denied',
          reason: err instanceof GatewayFailure ? err.error.message : 'Unexpected internal error.',
        };
      }
    }

    record(
      `${toolName} (approval check)`,
      rawArgs,
      decision.type === 'user-approval'
        ? { ok: true, data: { approvalRequested: decision.reason } }
        : { ok: false, error: { code: 'not_eligible', message: decision.reason, retryable: false } },
      serviceCalls,
      startedAt,
    );
    return decision;
  }

  // Checks the action and builds the text shown on the approval card.
  async function describe(toolName: ApprovalTool, args: unknown, h: ReturnType<typeof helpers>): Promise<string> {
    switch (toolName) {
      case 'issue_refund': {
        const { orderId: id, claim: claimType } = args as z.output<typeof TOOL_INPUTS.issue_refund>;
        if (used.refunds >= RUN_LIMITS.refunds) fail('limit_reached', 'Only one refund can be issued per conversation turn.');
        const { order, decision } = await h.evaluate(id, claimType);
        if (decision.action === 'staff_review') {
          fail(
            'not_eligible',
            `The assistant may not refund this order itself: ${decision.staffReviewReasons.join(' ')} Use request_staff_refund to send it to the support team.`,
          );
        }
        if (decision.action !== 'bot_refund') fail('not_eligible', decision.reason);
        const items = order.items.map((i) => `${i.name} x${i.quantity}`).join(', ');
        return `Refund ${money(order.total)} to your original payment method for order ${id} (${items}).`;
      }
      case 'request_staff_refund': {
        const { orderId: id, claim: claimType } = args as z.output<typeof TOOL_INPUTS.request_staff_refund>;
        if (used.refundRequests >= RUN_LIMITS.refundRequests) fail('limit_reached', 'Only one refund request can be filed per conversation turn.');
        const { order, decision } = await h.evaluate(id, claimType);
        if (decision.action === 'bot_refund') fail('not_eligible', 'This order does not need staff review. Use issue_refund instead.');
        if (decision.action !== 'staff_review') fail('not_eligible', decision.reason);
        return `Send a refund request for ${money(order.total)} on order ${id} to our support team. They will review it, and the decision will appear on your order.`;
      }
      case 'escalate_to_human': {
        const { orderId: id, summary } = args as z.output<typeof TOOL_INPUTS.escalate_to_human>;
        if (used.escalations >= RUN_LIMITS.escalations) fail('limit_reached', 'A ticket was already opened in this conversation turn.');
        h.checkTicketCap();
        const target = await h.ticketOrder(id, summary);
        const about = target.orderId ? ` about order ${target.orderId}` : '';
        return `Open a support ticket${about}. A specialist will reply by email within 24 hours. The ticket will say: "${summary}"`;
      }
    }
  }

  // Runs when an approved call comes back, before the AI SDK executes it.
  // Refuses unless the server recorded this exact approval request.
  function revalidateApproval(toolName: ApprovalTool, rawArgs: unknown, toolCallId: string): ApprovalDecision {
    const parsed = parse(toolName, rawArgs);
    if (!parsed.ok) return { type: 'denied', reason: parsed.error.message };
    const approval = checkApproval({ toolCallId, customerId: deps.customerId, tool: toolName, input: parsed.data });
    return approval.ok
      ? { type: 'user-approval', reason: approval.record.description }
      : { type: 'denied', reason: approval.reason };
  }

  return { call, requestApproval, revalidateApproval, customerId: deps.customerId };
}
