import { NextResponse } from 'next/server';
import { fetchActiveDisasters } from '@/lib/intel/gdacs';

export const runtime = 'nodejs';
export const revalidate = 600;

export async function GET() {
  const data = await fetchActiveDisasters();
  return NextResponse.json({ ok: true, layer: 'gdacs', data });
}
