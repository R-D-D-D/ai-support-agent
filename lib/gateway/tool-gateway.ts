// Tool gateway. Every tool the agent can call goes through `call()` here.
//
// For each call it:
//   1. validates the input against the tool's schema,
//   2. checks that any order belongs to the signed-in customer (an order owned
//      by someone else is reported as "not found"),
//   3. enforces per-run limits on actions that change data,
//   4. calls the backend through safeCall (fault injection, timeout, retry,
//      response validation),
//   5. returns only allowlisted fields, with outside free text marked untrusted,
//   6. records the call in the run log.
//
// The customer id comes from the verified session when the gateway is created.
// No tool takes a customer id as input, so the model has nothing to forge.

import { z } from 'zod';
import type { RunRecorder, ServiceCallRecord } from '@/lib/agent/run-log';
import {
  orderDetailDto,
  orderSummaryDto,
  refundDto,
  shipmentDto,
  ticketDto,
} from '@/lib/gateway/dto';
import { safeCall, type SafeCallOptions } from '@/lib/gateway/safe-call';
import {
  createdRefundSchema,
  createdTicketSchema,
  orderSchema,
  refundSchema,
  shipmentSchema,
  ticketSchema,
} from '@/lib/gateway/schemas';
import type { ToolError, ToolErrorCode, ToolResult } from '@/lib/gateway/types';
import { checkRefundEligibility, type ClaimType } from '@/lib/policy/refund-policy';
import * as ordersService from '@/lib/services/orders';
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
  escalate_to_human: z.object({
    orderId: orderId.optional(),
    reason: z.enum([
      'refund_needs_approval',
      'missing_package',
      'tool_failure',
      'customer_request',
      'other',
    ]),
    summary: z
      .string()
      .min(10)
      .max(1000)
      .describe('A short summary of the issue and what has been checked so far, for the human agent.'),
    priority: z.enum(['normal', 'high']).default('normal'),
  }),
} as const;

export type ToolName = keyof typeof TOOL_INPUTS;

// Limits on data-changing actions within one agent run.
export const RUN_LIMITS = { refunds: 1, escalations: 1 } as const;

class GatewayFailure extends Error {
  constructor(readonly error: ToolError) {
    super(error.message);
  }
}

function fail(code: ToolErrorCode, message: string, retryable = false): never {
  throw new GatewayFailure({ code, message, retryable });
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
  const used = { refunds: 0, escalations: 0 };

  async function call(toolName: ToolName, rawArgs: unknown): Promise<ToolResult> {
    const startedAt = Date.now();
    const serviceCalls: ServiceCallRecord[] = [];

    // Calls one backend service and records the attempt. Throws GatewayFailure
    // when the service fails after retries.
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
      const ticket = await load('tickets', ticketSchema.nullable(), () =>
        ticketsService.findOpenTicketForOrder(id),
      );
      const decision = checkRefundEligibility({
        order,
        shipment,
        claim: claimType,
        now: now(),
        hasRefund: refund !== null,
        hasOpenTicket: ticket !== null,
      });
      return { order, decision };
    }

    const handlers: { [K in ToolName]: (args: z.output<(typeof TOOL_INPUTS)[K]>) => Promise<unknown> } = {
      list_my_orders: async () => {
        const orders = await load('orders', z.array(orderSchema), () =>
          ordersService.listOrdersForCustomer(deps.customerId),
        );
        // Belt and braces: drop anything that is not this customer's.
        return { orders: orders.filter((o) => o.customerId === deps.customerId).map(orderSummaryDto) };
      },

      get_order_details: async ({ orderId: id }) => {
        const order = await ownedOrder(id);
        const refund = await load('refunds', refundSchema.nullable(), () =>
          refundsService.findRefundForOrder(id),
        );
        const ticket = await load('tickets', ticketSchema.nullable(), () =>
          ticketsService.findOpenTicketForOrder(id),
        );
        return orderDetailDto(order, refund, ticket);
      },

      get_shipment_tracking: async ({ orderId: id }) => {
        await ownedOrder(id);
        const shipment = await load('shipments', shipmentSchema.nullable(), () =>
          shipmentsService.getShipmentForOrder(id),
        );
        if (!shipment) fail('not_found', `No shipment record exists for order ${id}.`);
        return shipmentDto(shipment);
      },

      check_refund_eligibility: async ({ orderId: id, claim: claimType }) => {
        const { decision } = await evaluate(id, claimType);
        return { orderId: id, claim: claimType, ...decision };
      },

      issue_refund: async ({ orderId: id, claim: claimType }) => {
        // Reserve the slot before any await so two parallel calls cannot both pass.
        if (used.refunds >= RUN_LIMITS.refunds) {
          fail('limit_reached', 'Only one refund can be issued per conversation turn.');
        }
        used.refunds += 1;
        try {
          // The policy is checked again here, whatever the model concluded
          // earlier. The amount always comes from the stored order total.
          const { order, decision } = await evaluate(id, claimType);
          if (decision.action !== 'auto_refund') {
            fail(
              'not_eligible',
              `Refund refused by policy (${decision.action}): ${decision.reason}`,
            );
          }
          // Safe to retry: createRefund is idempotent per order.
          const { refund, created } = await load('refunds', createdRefundSchema, () =>
            refundsService.createRefund({
              orderId: id,
              customerId: deps.customerId,
              amount: order.total,
              reason: decision.reason,
            }),
          );
          return {
            ...refundDto(refund),
            alreadyExisted: !created,
            message: 'Refund issued to the original payment method. It usually appears within 5 to 10 business days.',
          };
        } catch (err) {
          used.refunds -= 1;
          throw err;
        }
      },

      escalate_to_human: async ({ orderId: id, reason, summary, priority }) => {
        if (used.escalations >= RUN_LIMITS.escalations) {
          fail('limit_reached', 'A ticket was already opened in this conversation turn.');
        }
        used.escalations += 1;
        try {
          let ticketOrderId: string | null = null;
          let ticketSummary = summary;
          if (id) {
            try {
              ticketOrderId = (await ownedOrder(id)).id;
            } catch (err) {
              // If the order service is down we still open the ticket, without
              // linking an order we could not verify.
              if (err instanceof GatewayFailure && err.error.retryable) {
                ticketSummary = `${summary}\n\n[Customer referenced order ${id}; ownership not verified because the order service was unavailable.]`;
              } else {
                throw err;
              }
            }
          }
          const { ticket, created } = await load('tickets', createdTicketSchema, () =>
            ticketsService.createTicket({
              orderId: ticketOrderId,
              customerId: deps.customerId,
              reason,
              summary: ticketSummary,
              priority,
            }),
          );
          return {
            ...ticketDto(ticket),
            alreadyExisted: !created,
            message: 'A support specialist will reply by email within 24 hours.',
          };
        } catch (err) {
          used.escalations -= 1;
          throw err;
        }
      },
    };

    let result: ToolResult;
    const schema = TOOL_INPUTS[toolName];
    if (!schema) {
      result = { ok: false, error: { code: 'invalid_input', message: `Unknown tool ${String(toolName)}.`, retryable: false } };
    } else {
      const parsed = schema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        result = {
          ok: false,
          error: { code: 'invalid_input', message: z.prettifyError(parsed.error), retryable: false },
        };
      } else {
        try {
          const handler = handlers[toolName] as (args: unknown) => Promise<unknown>;
          result = { ok: true, data: await handler(parsed.data) };
        } catch (err) {
          result =
            err instanceof GatewayFailure
              ? { ok: false, error: err.error }
              : { ok: false, error: { code: 'internal_error', message: 'Unexpected internal error.', retryable: false } };
        }
      }
    }

    deps.recorder?.recordToolCall({
      tool: String(toolName),
      input: rawArgs,
      ok: result.ok,
      output: result.ok ? result.data : undefined,
      error: result.ok ? undefined : result.error,
      serviceCalls,
      durationMs: Date.now() - startedAt,
      at: new Date(startedAt).toISOString(),
    });
    return result;
  }

  return { call, customerId: deps.customerId };
}
