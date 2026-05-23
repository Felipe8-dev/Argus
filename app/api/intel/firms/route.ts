import { NextRequest, NextResponse } from 'next/server';
import { fetchFiresAround } from '@/lib/intel/firms';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const lat = parseFloat(url.searchParams.get('lat') || '');
  const lng = parseFloat(url.searchParams.get('lng') || '');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ ok: false, error: 'lat/lng required' }, { status: 400 });
  }
  const data = await fetchFiresAround(lat, lng);
  return NextResponse.json({ ok: true, layer: 'firms', data, configured: data.configured });
}
