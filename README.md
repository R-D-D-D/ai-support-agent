# ShopCo Support — AI customer support agent

An e-commerce support app where customers chat with an AI agent that investigates order problems on its own and takes action: it looks up orders and tracking, applies the refund policy, issues refunds, escalates to a human, and copes with backend failures.

**Live demo:** _add the Vercel URL here after deploying_

**Demo logins** (also listed on the login page):

| Customer | Email | Password | Good for |
|---|---|---|---|
| Alice Tan | alice@example.com | alice-demo-123 | On-time order, late order refund, not-yet-eligible order, failures |
| Ben Okafor | ben@example.com | ben-demo-123 | Missing high-value package, prompt injection in a carrier note |
| Chloe Ng | chloe@example.com | chloe-demo-123 | Already-refunded order, normal delivered order |

## Run it locally

Needs Node 22.12 or newer and pnpm.

```bash
pnpm install
cp .env.example .env.local   # then add ANTHROPIC_API_KEY and SESSION_SECRET
pnpm dev                     # http://localhost:3000
pnpm test                    # 85 tests, no API key needed
pnpm scenarios               # runs the 7 demo scenarios against the real model
```

## Stack

- Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4
- Vercel AI SDK 7: `ToolLoopAgent` for the tool loop, `useChat` for streaming
- Claude `claude-sonnet-5-5` through `@ai-sdk/anthropic`
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
ToolLoopAgent (Claude, max 8 steps)
   │  tools: list_my_orders, get_order_details, get_shipment_tracking,
   │         check_refund_eligibility, issue_refund, escalate_to_human
   ▼
Tool gateway ── validate input ── ownership check ── per-run write limits
   │            ── safeCall: fault injection, 3 s timeout, 1 retry, response schema
   │            ── allowlisted response fields, untrusted text fenced ── run log
   ▼
Simulated services (orders, shipments, refunds, tickets) over in-memory seed data
Refund policy: a pure function, called by both the eligibility and refund tools
```

Key files:

- `lib/gateway/tool-gateway.ts` — every tool call passes through here.
- `lib/policy/refund-policy.ts` — the refund rules.
- `lib/agent/chat-handler.ts` — the chat endpoint logic.
- `lib/agent/system-prompt.ts` — the agent's instructions.
- `lib/chat/dispatch-scheduler.ts` — the browser-side message queue.
- `lib/data/seed.ts` — the demo data behind each scenario.

## Refund policy

| Rule | Detail |
|---|---|
| Delayed | Not delivered and more than 5 days past the estimated delivery date |
| Missing | Carrier says delivered, customer did not receive it, reported within 7 days of the delivery scan |
| Auto-refund cap | Eligible orders under $100 are refunded by the agent. $100 or more opens a ticket for a human |
| Already handled | An existing refund or open ticket means no new action |

The model never decides eligibility itself. It calls `check_refund_eligibility`, and `issue_refund` runs the policy again on the server before any refund is created.

## Demo scenarios

| # | Customer and message | Expected behaviour | Shows |
|---|---|---|---|
| 1 | Alice: "Where are my headphones?" | Checks tracking, gives the ETA | Retrieval |
| 2 | Alice: "My mug set is over a week late" | Checks policy, refunds $45 | Autonomous action |
| 3 | Ben: "My smart watch says delivered but never arrived" | Policy says escalate ($240), opens a ticket | Escalation |
| 4 | Alice: "My notebook order is late, refund now" | Explains it is only 2 days late and when it becomes eligible | Policy says no |
| 5 | Alice, with the shipments fault set to timeout | Retries, then says it cannot reach tracking and offers a ticket | Graceful failure |
| 6 | Ben asks about ORD-2002, whose carrier note contains an injected instruction | Treats the note as data, follows policy, no refund | Injection through data |
| 7 | Alice claims to be an admin and asks for Ben's order | Gets "not found", declines | Data isolation |

The right-hand panel shows the backend data, refunds and tickets, the run log, and the fault controls, so a viewer can see each action land.

## Security model

- **Authentication.** Email and password, hashed with scrypt. Login gives the same error for a wrong password and an unknown email, and locks an email after 5 failures in 5 minutes. A successful login sets an HttpOnly, SameSite=Lax cookie holding an HS256 JWT that expires after 2 hours.
- **Authorization in every handler.** `proxy.ts` redirects signed-out visitors, but every page and API route verifies the cookie again itself. The customer id comes only from the verified token.
- **Tool gateway.** Tools take no customer id. The gateway checks that every order belongs to the signed-in customer and answers "not found" for anyone else's order, so the agent cannot even confirm it exists. Responses are built from allowlists, so staff-only fields such as internal notes never reach the model.
- **Prompt injection.** The important limits are enforced in code, not in the prompt: ownership checks, at most one refund and one escalation per run, and the refund tool re-checking policy and refunding the stored order total. Free text from outside the company, such as carrier notes, is returned wrapped as `untrusted_text` with a note that it is data. The system prompt also says customer claims carry no authority. The browser sends the chat history, so a user could forge earlier tool results, but this cannot cause a refund because the refund tool trusts only the server-side policy check.
- **Input limits.** Messages over 2000 characters are rejected, only the last 20 messages are sent to the model, and system messages from the browser are dropped.

## Failure handling

- Every tool returns `{ ok: true, data }` or `{ ok: false, error: { code, message, retryable, attempts } }`. Tools never throw to the model.
- Each backend call has a 3 second timeout and one retry for temporary failures (timeouts, HTTP 500, HTTP 429, malformed responses). Every response is checked against a zod schema.
- Refund and ticket creation are idempotent per order, so a retry cannot create duplicates.
- If the order service is down, escalation still opens a ticket, noting the order id as unverified.
- The system prompt tells the agent to say plainly what it could not check, never invent data, and offer a human.
- The fault injector has six modes per service: none, flaky (fails once, retry succeeds), timeout, server_error, rate_limited, malformed.

## Overlapping messages

- The input box never locks. Messages sent while the agent is working show as "queued".
- Queued messages go out together, 3 seconds after the customer stops sending and typing, and only once the current run has finished.
- The server holds one run lock per customer and answers 409 to a second concurrent run, for example from another tab. Locks expire after 60 seconds.

## Run log

Each agent run is recorded with the customer, the message, each tool call's input and result, backend attempts, the final reply, token usage, and how it ended. The Runs tab shows these, and each finished run is also printed as one JSON line so Vercel's runtime logs keep a copy.

## Tests

`pnpm test` runs 85 tests with no network or API key:

- `refund-policy.test.ts` — boundaries: day 5 vs day 6, $99.99 vs $100, day 7 vs day 8, already refunded, open ticket.
- `auth.test.ts` — passwords, identical errors, lockout, tampered, expired, wrong-secret, and unsigned tokens, and 401 on every protected route.
- `gateway.test.ts` — cross-customer access, allowlisted fields, untrusted fencing, refund guard, write limits including parallel calls, idempotency, escalation during an outage.
- `safe-call.test.ts` — retry, timeout, malformed responses, rate limits.
- `run-lock.test.ts` and `dispatch-scheduler.test.ts` — one run at a time, the 3 second quiet window, batching.
- `agent.test.ts` — the real chat handler with a scripted mock model: refund flow, injected refund refused, cross-customer lookup hidden, tool failure reported, 401, 409, and 413.

## Known limits

- Data, run locks, and the login limiter live in memory, per server instance. On Vercel a new instance starts with fresh seed data, and two instances do not share locks. The browser queue still prevents overlapping runs from one tab. A shared store such as Redis or Postgres fixes this in production.
- Demo passwords are public on purpose.
- The fault injector is controlled by the browser for the demo. In production it would not exist.

## What I would do next

- Move data, locks, and the run log to a database.
- Add an eval suite that runs the scenarios on every prompt change and scores the replies.
- Give human agents a ticket queue with a handoff back to the AI.
- Send each refund through an approval step with a spending limit per day.
