import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { StaffQueue } from '@/components/staff-queue';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/session';
import { getStore } from '@/lib/data/store';

export const dynamic = 'force-dynamic';

export default async function StaffPage() {
  // Checked here as well as in every staff API route.
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const userId = await verifySessionToken(token);
  const user = userId ? getStore().customers.find((c) => c.id === userId) : undefined;
  if (!user) redirect('/login');
  if (user.role !== 'staff') redirect('/');

  return <StaffQueue staff={{ name: user.name, email: user.email }} />;
}
