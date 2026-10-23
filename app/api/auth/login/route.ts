import { z } from 'zod';
import { attemptLogin } from '@/lib/auth/login';
import { createSessionToken, sessionCookieHeader } from '@/lib/auth/session';

const bodySchema = z.object({
  email: z.string().max(200),
  password: z.string().max(200),
});

export async function POST(req: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  const result = attemptLogin(parsed.data.email, parsed.data.password);
  if (!result.ok) {
    if (result.reason === 'locked') {
      return Response.json(
        { error: 'locked', message: 'Too many failed attempts. Try again in a few minutes.' },
        { status: 429 },
      );
    }
    // Same message for an unknown email and a wrong password.
    return Response.json(
      { error: 'invalid_credentials', message: 'Invalid email or password.' },
      { status: 401 },
    );
  }

  const token = await createSessionToken(result.customer.id);
  return Response.json(
    { ok: true, customer: { name: result.customer.name, email: result.customer.email } },
    { headers: { 'Set-Cookie': sessionCookieHeader(token) } },
  );
}
