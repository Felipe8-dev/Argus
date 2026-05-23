import { NextResponse } from 'next/server';
import { fetchSignificantEarthquakes } from '@/lib/intel/usgs';

export const runtime = 'nodejs';
export const revalidate = 600;

export async function GET() {
  const data = await fetchSignificantEarthquakes();
  return NextResponse.json({ ok: true, layer: 'usgs', data });
}
