import { NextRequest, NextResponse } from 'next/server';
import { getSupa, emit, sleep } from '@/lib/argus-server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Pulse — periodic heartbeat. Reports a notification zone (where alerts
 * are being broadcast) and a status message that the operator dashboard
 * surfaces as the latest activity.
 */
export async function POST(req: NextRequest) {
  const db = getSupa();
  const { caseId, lat, lng, channels } = await req.json();
  if (!caseId) return NextResponse.json({ error: 'caseId required' }, { status: 400 });

  await emit(db, caseId, 'pulse', 'start', {
    status: 'notifying_channels',
    channels: channels || ['whatsapp', 'email'],
  });

  if (lat != null && lng != null) {
    await emit(db, caseId, 'pulse', 'progress', {
      status: 'broadcast_zone',
      zone: { label: 'Zona de alerta', lat: Number(lat), lng: Number(lng), radius_km: 2.4 },
      agent_position: { lat: Number(lat), lng: Number(lng) },
    });
  }

  const heartbeats = ['queued', 'authority_emailed', 'whatsapp_dispatched', 'standby'];
  for (const beat of heartbeats) {
    await emit(db, caseId, 'pulse', 'progress', { status: beat });
    await sleep(220);
  }

  await emit(db, caseId, 'pulse', 'complete', { status: 'alert_published' });

  return NextResponse.json({ ok: true });
}
