// First-line check that sends signed-out visitors to the login page.
// This is only a convenience. Every protected route and page verifies the
// session again itself, so a bug or bypass here cannot expose data.

import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/session';

export async function proxy(request: NextRequest) {
  const customerId = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (customerId) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized', message: 'Please sign in.' }, { status: 401 });
  }
  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  // Everything except the login page, the auth API, and static assets.
  matcher: ['/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)'],
};
