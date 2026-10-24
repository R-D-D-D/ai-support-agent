// A staff member approves or denies one refund request.

import { z } from 'zod';
import { requireStaff } from '@/lib/auth/current-customer';
import { decideRefundRequest } from '@/lib/staff/decide';

const bodySchema = z.object({
  approved: z.boolean(),
  note: z.string().max(500).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireStaff(req);
  if ('response' in auth) return auth.response;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });

  const { id } = await params;
  const result = await decideRefundRequest({ requestId: id, staff: auth.staff, ...parsed.data });
  if (!result.ok) {
    return Response.json({ error: result.error, message: result.message }, { status: result.status });
  }
  return Response.json({ request: result.request, refund: result.refund });
}
