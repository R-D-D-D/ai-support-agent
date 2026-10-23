import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { POST as login } from '@/app/api/auth/login/route';
import { GET as getData } from '@/app/api/data/route';
import { GET as getRuns } from '@/app/api/runs/route';
import { POST as resetDemo } from '@/app/api/demo/reset/route';
import { POST as chat } from '@/app/api/chat/route';
import { attemptLogin } from '@/lib/auth/login';
import { MAX_FAILURES, resetLimiter } from '@/lib/auth/login-limiter';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { createSessionToken, SESSION_COOKIE, verifySessionToken } from '@/lib/auth/session';
import { resetStore } from '@/lib/data/store';
import { sessionCookie } from './helpers';

beforeEach(() => {
  resetStore();
  resetLimiter();
});

function loginRequest(email: string, password: string) {
  return new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

describe('passwords', () => {
  it('verifies the right password and rejects a wrong one', () => {
    const hash = hashPassword('correct horse');
    expect(verifyPassword('correct horse', hash)).toBe(true);
    expect(verifyPassword('wrong horse', hash)).toBe(false);
    expect(verifyPassword('anything', 'not-a-hash')).toBe(false);
  });
});

describe('login', () => {
  it('signs in with the right password and sets an HttpOnly session cookie', async () => {
    const res = await login(loginRequest('alice@example.com', 'alice-demo-123'));
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    const token = decodeURIComponent(cookie.split(';')[0].split('=')[1]);
    expect(await verifySessionToken(token)).toBe('cus_alice');
  });

  it('accepts the email in any case', () => {
    expect(attemptLogin('  ALICE@example.com ', 'alice-demo-123').ok).toBe(true);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrongPassword = await login(loginRequest('alice@example.com', 'nope'));
    const unknownEmail = await login(loginRequest('nobody@example.com', 'nope'));
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(await unknownEmail.json());
    expect(wrongPassword.headers.get('set-cookie')).toBeNull();
  });

  it(`locks an email after ${MAX_FAILURES} failures, even with the right password`, async () => {
    for (let i = 0; i < MAX_FAILURES; i++) attemptLogin('ben@example.com', 'wrong');
    const res = await login(loginRequest('ben@example.com', 'ben-demo-123'));
    expect(res.status).toBe(429);
    // Other accounts are unaffected.
    expect(attemptLogin('alice@example.com', 'alice-demo-123').ok).toBe(true);
  });

  it('rejects a malformed body', async () => {
    const res = await login(
      new Request('http://localhost/api/auth/login', { method: 'POST', body: 'not json' }),
    );
    expect(res.status).toBe(400);
  });
});

describe('session tokens', () => {
  it('rejects a tampered token', async () => {
    const token = await createSessionToken('cus_alice');
    const [h, , s] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'cus_ben', iss: 'support-agent' })).toString('base64url');
    expect(await verifySessionToken(`${h}.${forgedPayload}.${s}`)).toBeNull();
  });

  it('rejects a token signed with another secret', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('cus_alice')
      .setIssuer('support-agent')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('some-other-secret-that-is-32-chars-long!!'));
    expect(await verifySessionToken(token)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const token = await createSessionToken('cus_alice', threeHoursAgo);
    expect(await verifySessionToken(token)).toBeNull();
  });

  it('rejects an unsigned token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'cus_alice', iss: 'support-agent' })).toString('base64url');
    expect(await verifySessionToken(`${header}.${payload}.`)).toBeNull();
  });
});

describe('protected routes', () => {
  const routes: [string, (req: Request) => Promise<Response>, string][] = [
    ['GET /api/data', getData, 'GET'],
    ['GET /api/runs', getRuns, 'GET'],
    ['POST /api/demo/reset', resetDemo, 'POST'],
    ['POST /api/chat', chat, 'POST'],
  ];

  for (const [name, handler, method] of routes) {
    it(`${name} returns 401 without a session`, async () => {
      const res = await handler(
        new Request('http://localhost/x', {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: method === 'POST' ? JSON.stringify({ messages: [] }) : undefined,
        }),
      );
      expect(res.status).toBe(401);
    });
  }

  it("GET /api/data returns only the signed-in customer's orders", async () => {
    const res = await getData(new Request('http://localhost/api/data', { headers: { cookie: await sessionCookie('cus_ben') } }));
    const body = await res.json();
    expect(body.orders.map((o: { id: string }) => o.id).sort()).toEqual(['ORD-2001', 'ORD-2002']);
    expect(JSON.stringify(body)).not.toContain('internalNotes');
  });

  it('rejects a session for a customer that does not exist', async () => {
    const res = await getData(new Request('http://localhost/api/data', { headers: { cookie: await sessionCookie('cus_ghost') } }));
    expect(res.status).toBe(401);
  });
});
