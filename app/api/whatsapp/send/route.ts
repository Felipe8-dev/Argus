import { NextRequest, NextResponse } from 'next/server';
import { emit, getSupa } from '@/lib/argus-server';
import { send, health } from '@/lib/whatsapp-bridge';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /api/whatsapp/send
 *
 * Body: { caseId?, to, text?, imageUrl?, caption?, kind? }
 *
 * Proxies to the Argus WhatsApp bridge on the operator's VPS (Baileys
 * can't run on Vercel). Logs a pulse pipeline_event so the operator
 * dashboard surfaces every WA notification next to the email + Facebook
 * fan-out.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { caseId, to, text, imageUrl, caption, kind } = body as {
    caseId?: string;
    to: string;
    text?: string;
    imageUrl?: string;
    caption?: string;
    kind?: 'alert' | 'found' | 'update';
  };

  if (!to) return NextResponse.json({ error: 'to required' }, { status: 400 });
  if (!text && !imageUrl) {
    return NextResponse.json({ error: 'text or imageUrl required' }, { status: 400 });
  }

  const db = getSupa();
  if (caseId) {
    await emit(db, caseId, 'pulse', 'progress', {
      status: 'whatsapp_dispatching',
      channel: 'whatsapp',
      kind: kind || 'alert',
      to: to.replace(/\d(?=\d{4})/g, '*'),
    });
  }

  const result = await send({ to, text, imageUrl, caption });

  if (caseId) {
    await emit(db, caseId, 'pulse', result.ok ? 'complete' : 'error', {
      status: result.ok ? 'whatsapp_sent' : 'whatsapp_failed',
      channel: 'whatsapp',
      kind: kind || 'alert',
      messageId: result.messageId,
      error: result.error,
    });
  }

  return NextResponse.json({
    ok: result.ok,
    messageId: result.messageId,
    to: result.to,
    error: result.error,
  }, { status: result.ok ? 200 : 502 });
}

export async function GET() {
  const h = await health();
  return NextResponse.json(h);
}
