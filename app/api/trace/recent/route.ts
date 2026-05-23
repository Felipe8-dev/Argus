import { NextRequest, NextResponse } from 'next/server';
import { getRecentSpans } from '@/lib/trace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '60', 10)));
  return NextResponse.json({ ok: true, spans: getRecentSpans(limit) });
}
