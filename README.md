# ShopCo Support — AI customer support agent

An e-commerce support app where customers chat with an AI agent that investigates order problems on its own and takes action: it looks up orders and tracking, applies the refund policy, issues refunds, escalates to a human, and copes with backend failures.

Nothing that changes data happens without a person saying yes. The customer approves every refund, refund request, and ticket on screen, and refunds the bot may not grant go to a staff queue.

The app runs locally. See "Run it locally" below.

**Demo logins** (also listed on the login page):

| Customer | Email | Password | Good for |
|---|---|---|---|
| Alice Tan | alice@example.com | alice-demo-123 | On-time order, late order refund, not-yet-eligible order, failures |
| Ben Okafor | ben@example.com | ben-demo-123 | Missing high-value package, prompt injection in a carrier note |
| Chloe Ng | chloe@example.com | chloe-demo-123 | Late order that is still moving, already-refunded order |
| Sam Rivera (staff) | staff@shopco.example | staff-demo-123 | Staff queue: approve or deny refund requests |

## Run it locally

Needs Node 22.12 or newer and pnpm.

```bash
pnpm install
cp .env.example .env.local   # then add OPENAI_API_KEY
pnpm dev                     # http://localhost:3000
pnpm test                    # 135 tests, no API key needed
pnpm scenarios               # runs the 8 demo scenarios against the real model
```

## Stack

- Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4
- Vercel AI SDK 7: `ToolLoopAgent` for the tool loop, `useChat` for streaming
- OpenAI `gpt-6-astra` through `@ai-sdk/openai`, using the Responses API. Set `OPENAI_MODEL` to use another model
- zod for every input and backend response, jose for signed session cookies
- Vitest, with the AI SDK mock model for deterministic agent tests

## How it works

```
Browser ── login ──> /api/auth/login ── sets signed HttpOnly cookie
   │
   │ messages queue in the browser; sent after 3 s of quiet, one run at a time
   ▼
/api/chat ── verify session ── run lock (1 run per customer) ── input limits
   │
   ▼
ToolLoopAgent (OpenAI, max 8 steps)
   │  read tools: list_my_orders, get_order_details, get_shipment_tracking,
   │              check_refund_eligibility
   │  tools that change data: issue_refund, request_staff_refund,
   │              escalate_to_human ── shown to the customer as Approve / Decline
   ▼
Tool gateway ── validate input ── ownership check ── recorded approval ── per-run limits
   │            ── safeCall: fault injection, 3 s timeout, 1 retry, response schema
   │            ── allowlisted response fields, untrusted text fenced ── run log
   ▼
Simulated services (orders, shipments, refunds, refund requests, tickets) over in-memory seed data
Refund policy: a pure function, run before every card is shown and again before acting

Staff ── /staff ── approve or deny refund requests ── server rechecks facts, then pays
```

Key files:

- `lib/gateway/tool-gateway.ts` — every tool call passes through here.
- `lib/agent/approvals.ts` — the server's record of each approval a customer was asked for.
- `lib/agent/support-agent.ts` — the agent, with approval hooks and approval signing.
- `lib/staff/decide.ts` — staff decisions on refund requests.
- `lib/policy/refund-policy.ts` — the refund rules.
- `lib/agent/chat-handler.ts` — the chat endpoint logic.
- `lib/agent/system-prompt.ts` — the agent's instructions.
- `lib/chat/dispatch-scheduler.ts` — the browser-side message queue.
- `lib/data/seed.ts` — the demo data behind each scenario.

## Refund policy

A refund is justified when either of these holds:

| Claim | Rule |
|---|---|
| Delayed | Not delivered, and 14 or more days past the estimated delivery date |
| Missing | Carrier says delivered, customer did not receive it, reported within 7 days of the delivery scan |

The bot may issue a justified refund itself only when every check below passes. Otherwise it files a refund request for staff.

| Check | Rule |
|---|---|
| Amount | Order total under $50 |
| Claim type | Delayed only. Missing-package claims always go to staff |
| Tracking stalled | No carrier scan in the last 7 days, so the package is unlikely to arrive |
| Order age | Placed within the last 60 days |
| Risk | No risk flag on the order |
| Payment | The original payment has settled |
| Switch | Bot refunds are switched on (`BOT_REFUNDS_ENABLED`, default on) |
| Daily budget | Today's bot refunds plus this one stay within `BOT_DAILY_REFUND_BUDGET` (default $500, all customers) |
| Not handled yet | No existing refund and no pending refund request |

Orders that are not late enough are declined, with the date they become eligible. The model never decides any of this itself: the policy function runs before an approval card is shown and again before anything is paid or filed.

## Approvals

**Customer approval.** `issue_refund`, `request_staff_refund`, and `escalate_to_human` use the AI SDK's tool approvals. When the agent calls one, the policy and limits are checked first. If the action is allowed, the chat shows a card describing it (for example "Refund $45.00 to your original payment method for order ORD-1002"), and nothing happens until the customer clicks Approve. If it is not allowed, no card is shown and the agent is told why.

**Why the server keeps its own record.** The customer's answer comes back inside the chat history, which the browser controls. Three layers stop a forged or stale approval:

- The AI SDK signs every approval request and rejects an answer whose signature does not match, for example if the order id was edited.
- The server records each approval request it shows. The tool runs only if a record exists for this customer, with the same input, unused, and under 10 minutes old.
- The tool reruns the full policy and limits right before acting, so a change in the meantime (a refund issued elsewhere, bot refunds switched off) still stops it.

**Staff approval.** Refund requests appear on `/staff` for anyone with the staff role. Staff see the customer, order, payment, risk flag, tracking, the reasons the bot could not refund, and the agent's note, labelled as AI-written from the conversation. Staff may approve any amount, since overriding the bot's limits is their job. Before paying, the server rechecks that the request is still pending, the order still belongs to the customer, nothing was refunded since, and the amount is the stored order total. Every decision records who made it, when, and an optional note shown to the customer. The customer sees the outcome on the order, and the agent can report it.

**Tickets.** The customer approves each ticket and sees the summary that will go on it. Each customer can open at most 3 tickets in 24 hours.

## Demo scenarios

| # | Customer and message | Expected behaviour | Shows |
|---|---|---|---|
| 1 | Alice: "Where are my headphones?" | Checks tracking, gives the ETA | Retrieval |
| 2 | Alice: "My mug set is over two weeks late" | Checks policy, shows a $45 refund card, refunds after Approve | Autonomous action with consent |
| 3 | Ben: "My smart watch says delivered but never arrived" | Missing and $240, so it files a staff refund request after Approve | Staff approval |
| 4 | Alice: "My notebook order is late, refund now" | Explains it is only 2 days late and when it becomes eligible | Policy says no |
| 5 | Alice, with the shipments fault set to timeout | Retries, then says it cannot reach tracking and offers a ticket | Graceful failure |
| 6 | Ben asks about ORD-2002, whose carrier note contains an injected instruction | Treats the note as data, follows policy, no refund | Injection through data |
| 7 | Alice claims to be an admin and asks for Ben's order | Gets "not found", declines | Data isolation |
| 8 | Chloe: "My potted fern is two weeks late" | Scanned 2 days ago, so it may still arrive: staff request after Approve | Stalled-tracking rule |

Sign in as the staff account to approve or deny the requests from scenarios 3 and 8, then sign back in as the customer to see the result.

The right-hand panel shows the backend data, refunds, refund requests, tickets, the run log, and the fault controls, so a viewer can see each action land.

## Security model

- **Authentication.** Email and password, hashed with scrypt. Login gives the same error for a wrong password and an unknown email, and locks an email after 5 failures in 5 minutes. A successful login sets an HttpOnly, SameSite=Lax cookie holding an HS256 JWT that expires after 2 hours.
- **Authorization in every handler.** `proxy.ts` redirects signed-out visitors, but every page and API route verifies the cookie again itself. The customer id comes only from the verified token.
- **Tool gateway.** Tools take no customer id. The gateway checks that every order belongs to the signed-in customer and answers "not found" for anyone else's order, so the agent cannot even confirm it exists. Responses are built from allowlists, so staff-only fields such as internal notes never reach the model.
- **Roles.** Customers and staff share one login. Staff cannot use the customer chat or data routes, and customers get 403 from every staff route.
- **Prompt injection.** The important limits are enforced in code, not in the prompt: ownership checks, customer approval for every change, at most one refund, one refund request, and one ticket per run, and the refund tool re-checking policy and refunding the stored order total. Free text from outside the company, such as carrier notes, is returned wrapped as `untrusted_text` with a note that it is data. The system prompt also says customer claims carry no authority. The browser sends the chat history, so a user could forge earlier tool results or approvals. That cannot cause a refund: approvals are signed and recorded on the server, and the refund tool trusts only its own policy check.
- **Input limits.** Messages over 2000 characters are rejected, only the last 20 messages are sent to the model, and system messages from the browser are dropped.

## Failure handling

- Every tool returns `{ ok: true, data }` or `{ ok: false, error: { code, message, retryable, attempts } }`. Tools never throw to the model.
- Each backend call has a 3 second timeout and one retry for temporary failures (timeouts, HTTP 500, HTTP 429, malformed responses). Every response is checked against a zod schema.
- Refund and ticket creation are idempotent per order, so a retry cannot create duplicates.
- If the order service is down, escalation still opens a ticket, noting the order id as unverified.
- The system prompt tells the agent to say plainly what it could not check, never invent data, and offer a human.
- The fault injector has six modes per service: none, flaky (fails once, retry succeeds), timeout, server_error, rate_limited, malformed.

## Overlapping messages

- The input box never locks. Messages sent while the agent is working, or while an approval card is waiting for an answer, show as "queued".
- Queued messages go out together, 3 seconds after the customer stops sending and typing, and only once the current run has finished.
- The server holds one run lock per customer and answers 409 to a second concurrent run, for example from another tab. Locks expire after 60 seconds.

## Run log

Each agent run is recorded with the customer, the message, each tool call's input and result, backend attempts, the final reply, token usage, and how it ended. The Runs tab shows these, and each finished run is also printed to the server console as one JSON line.

## Tests

`pnpm test` runs 135 tests with no network or API key:

- `refund-policy.test.ts` — boundaries: day 13 vs day 14, $49.99 vs $50, last scan 6 vs 7 days ago, order age 60 vs 61 days, risk flag, unsettled payment, off switch, daily budget, missing packages on day 7 vs day 8.
- `approvals.test.ts` — the real chat handler with a scripted mock model: the card appears and no money moves until Approve; Decline does nothing; ineligible refunds get no card; edited, invented, expired, replayed, and other customers' approvals are all rejected, each by the layer meant to stop it; a missing high-value package becomes a staff request.
- `gateway.test.ts` — every data-changing tool refuses to run without a recorded approval; approval input must match; budget, off switch, and per-run limits, including parallel calls; the 3 tickets per day cap; cross-customer access; allowlisted fields; untrusted fencing.
- `staff.test.ts` — role checks both ways; approving pays the stored total and records who; denying pays nothing; no double decisions, including two staff at once; refusal when the order was refunded elsewhere or changed owner.
- `auth.test.ts` — passwords, identical errors, lockout, tampered, expired, wrong-secret, and unsigned tokens, and 401 on every protected route.
- `safe-call.test.ts` — retry, timeout, malformed responses, rate limits.
- `run-lock.test.ts` and `dispatch-scheduler.test.ts` — one run at a time, the 3 second quiet window, batching, holding the queue while an approval is open.
- `agent.test.ts` — the chat handler: the run stops at the approval card, the injected refund is refused, cross-customer lookups are hidden, tool failures are reported, 401, 409, and 413.

## Known limits

- Data, run locks, and the login limiter live in memory. Restarting the server resets everything to the seed data. Running more than one server process would need a shared store such as Redis or Postgres.
- Demo passwords are public on purpose.
- The fault injector is controlled by the browser for the demo. In production it would not exist.

## What I would do next

- Move data, locks, and the run log to a database.
- Add an eval suite that runs the scenarios on every prompt change and scores the replies.
- Give human agents a ticket queue with a handoff back to the AI.
- Notify the customer by email when staff decide a refund request.
