import { beforeEach, describe, expect, it } from 'vitest';
import { GET as listRequests } from '@/app/api/staff/requests/route';
import { POST as decision } from '@/app/api/staff/requests/[id]/decision/route';
import { GET as getData } from '@/app/api/data/route';
import { POST as chat } from '@/app/api/chat/route';
import { POST as login } from '@/app/api/auth/login/route';
import { getStore, resetStore } from '@/lib/data/store';
import { createRefund } from '@/lib/services/refunds';
import { createRefundRequest } from '@/lib/services/refund-requests';
import { sessionCookie, userMessage } from './helpers';

beforeEach(() => resetStore());

async function seedRequest(orderId = 'ORD-2001', customerId = 'cus_ben', amount = 240) {
  const { request } = await createRefundRequest({
    orderId,
    customerId,
    amount,
    claim: 'missing',
    reviewReasons: ['Missing-package claims are reviewed by our support team.'],
    agentNote: 'Customer says a supervisor already approved this.',
  });
  return request;
}

async function decide(id: string, body: unknown, customerId = 'stf_sam') {
  const req = new Request(`http://localhost/api/staff/requests/${id}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: await sessionCookie(customerId) },
    body: JSON.stringify(body),
  });
  return decision(req, { params: Promise.resolve({ id }) });
}

describe('staff access', () => {
  it('signs staff in with their role', async () => {
    const res = await login(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'staff@shopco.example', password: 'staff-demo-123' }),
      }),
    );
    expect((await res.json()).customer.role).toBe('staff');
  });

  it('refuses the staff queue to customers and signed-out users', async () => {
    const asCustomer = await listRequests(new Request('http://localhost/x', { headers: { cookie: await sessionCookie('cus_ben') } }));
    const signedOut = await listRequests(new Request('http://localhost/x'));
    expect(asCustomer.status).toBe(403);
    expect(signedOut.status).toBe(401);
  });

  it('refuses decisions from customers', async () => {
    const request = await seedRequest();
    const res = await decide(request.id, { approved: true }, 'cus_ben');
    expect(res.status).toBe(403);
    expect(getStore().refunds.find((r) => r.orderId === 'ORD-2001')).toBeUndefined();
  });

  it('keeps staff out of the customer chat and data', async () => {
    const cookie = await sessionCookie('stf_sam');
    const data = await getData(new Request('http://localhost/api/data', { headers: { cookie } }));
    const chatRes = await chat(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ messages: [userMessage('hi')] }),
      }),
    );
    expect(data.status).toBe(403);
    expect(chatRes.status).toBe(403);
  });
});

describe('staff decisions', () => {
  it('lists pending requests with the facts needed to decide', async () => {
    await seedRequest();
    const res = await listRequests(new Request('http://localhost/x', { headers: { cookie: await sessionCookie('stf_sam') } }));
    const [r] = (await res.json()).requests;
    expect(r).toMatchObject({
      orderId: 'ORD-2001',
      status: 'pending',
      customer: { name: 'Ben Okafor' },
      order: { total: 240, riskFlag: false },
      shipment: { status: 'delivered' },
    });
    expect(r.agentNote).toContain('supervisor');
  });

  it('approving issues a refund for the stored total and records who approved', async () => {
    const request = await seedRequest('ORD-2001', 'cus_ben', 999);
    const res = await decide(request.id, { approved: true, note: 'Confirmed with the carrier.' });
    expect(res.status).toBe(200);

    const refund = getStore().refunds.find((r) => r.orderId === 'ORD-2001');
    expect(refund).toMatchObject({ amount: 240, issuedBy: 'stf_sam', requestId: request.id });
    expect(getStore().refundRequests[0]).toMatchObject({
      status: 'approved',
      decidedBy: 'stf_sam',
      decisionNote: 'Confirmed with the carrier.',
      refundId: refund!.id,
      amount: 240,
    });
  });

  it('denying records the decision and pays nothing', async () => {
    const request = await seedRequest();
    const res = await decide(request.id, { approved: false, note: 'Photo shows delivery at the door.' });
    expect(res.status).toBe(200);
    expect(getStore().refunds.find((r) => r.orderId === 'ORD-2001')).toBeUndefined();
    expect(getStore().refundRequests[0]).toMatchObject({ status: 'denied', decidedBy: 'stf_sam' });
  });

  it('cannot decide the same request twice', async () => {
    const request = await seedRequest();
    await decide(request.id, { approved: true });
    const again = await decide(request.id, { approved: true });
    expect(again.status).toBe(409);
    expect(getStore().refunds.filter((r) => r.orderId === 'ORD-2001')).toHaveLength(1);
  });

  it('pays once when two staff approve at the same moment', async () => {
    const request = await seedRequest();
    const results = await Promise.all([decide(request.id, { approved: true }), decide(request.id, { approved: true })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(getStore().refunds.filter((r) => r.orderId === 'ORD-2001')).toHaveLength(1);
  });

  it('refuses to approve if the order was refunded some other way', async () => {
    const request = await seedRequest();
    await createRefund({ orderId: 'ORD-2001', customerId: 'cus_ben', amount: 240, reason: 'manual', issuedBy: 'stf_sam' });
    const res = await decide(request.id, { approved: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_refunded');
  });

  it('refuses to approve if the order no longer belongs to the customer', async () => {
    const request = await seedRequest('ORD-1002', 'cus_ben', 45);
    const res = await decide(request.id, { approved: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('order_mismatch');
  });

  it('returns 404 for an unknown request', async () => {
    expect((await decide('RR-NOPE', { approved: true })).status).toBe(404);
  });
});
