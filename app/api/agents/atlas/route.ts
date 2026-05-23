import { NextRequest, NextResponse } from 'next/server';
import { getSupa, emit, sleep } from '@/lib/argus-server';
import { offsetKm, probableSectors } from '@/lib/geo';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Atlas — projects probable movement zones outward from the last-seen
 * location and stamps a series of pipeline_events that the live map renders
 * as expanding scan rings + an "atlas" agent marker walking the route.
 */
export async function POST(req: NextRequest) {
  const db = getSupa();
  const { caseId, lat, lng } = await req.json();
  if (!caseId || lat == null || lng == null) {
    return NextResponse.json({ error: 'caseId, lat and lng required' }, { status: 400 });
  }

  await emit(db, caseId, 'atlas', 'start', {
    status: 'projecting_search_radius',
    lat,
    lng,
  });

  const center = { lat: Number(lat), lng: Number(lng) };
  const sectors = probableSectors(center, 0.95);
  const path = [
    center,
    offsetKm(center, 0.6, 0.4),
    offsetKm(center, 1.3, 0.7),
    offsetKm(center, 1.9, 1.4),
    offsetKm(center, 2.6, 1.9),
  ];

  for (let i = 0; i < sectors.length; i++) {
    const s = sectors[i];
    await emit(db, caseId, 'atlas', 'progress', {
      status: 'scanning_sector',
      step: 'atlas_zone',
      zone: { label: s.label, lat: s.lat, lng: s.lng, radius_km: s.radiusKm },
      agent_position: { lat: s.lat, lng: s.lng },
      progress: (i + 1) / sectors.length,
      sector_index: i,
      sector_total: sectors.length,
    });
    await sleep(420);
  }

  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    await emit(db, caseId, 'atlas', 'progress', {
      status: 'walking_probable_route',
      step: 'atlas_path',
      agent_position: { lat: p.lat, lng: p.lng },
      progress: (i + 1) / path.length,
    });
    await sleep(300);
  }

  await emit(db, caseId, 'atlas', 'complete', {
    status: 'route_projected',
    sectors_count: sectors.length,
    path_length: path.length,
  });

  return NextResponse.json({ ok: true, sectors, path });
}
