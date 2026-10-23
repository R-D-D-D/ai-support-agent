import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SupportApp } from '@/components/support-app';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/session';
import { getStore } from '@/lib/data/store';

export const dynamic = 'force-dynamic';

export default async function Home() {
  // Verified here as well as in proxy.ts: the page never trusts the proxy alone.
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const customerId = await verifySessionToken(token);
  const customer = customerId ? getStore().customers.find((c) => c.id === customerId) : undefined;
  if (!customer) redirect('/login');

  return <SupportApp customer={{ name: customer.name, email: customer.email }} />;
}
