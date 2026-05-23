import { NextRequest, NextResponse } from 'next/server';
import { emit, getSupa } from '@/lib/argus-server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Overpass / OSM critical-infrastructure scan.
 *
 * Around the last-seen location we query OSM via Overpass for:
 *   - police stations (amenity=police)
 *   - hospitals + clinics (amenity in {hospital, clinic, doctors})
 *   - shelters (amenity=shelter, social_facility~refugee|homeless)
 *   - transport hubs (amenity in {bus_station, taxi}, public_transport=station)
 *
 * The operator sees them as a layer on the map and Pulse / Alert use the
 * list to decide *which* authorities to notify first. Defensive value:
 * resilient response routing even when official records are stale.
 */

const ENDPOINT = process.env.INTEL_OVERPASS_ENDPOINT || 'https://overpass-api.de/api/interpreter';

interface PoiNode {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat: number;
  lon: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function buildQuery(lat: number, lng: number, radiusM: number) {
  // Overpass QL. We grab nodes/ways/relations for each amenity in one shot.
  return `
    [out:json][timeout:18];
    (
      node["amenity"="police"](around:${radiusM},${lat},${lng});
      way["amenity"="police"](around:${radiusM},${lat},${lng});
      node["amenity"~"hospital|clinic|doctors"](around:${radiusM},${lat},${lng});
      way["amenity"~"hospital|clinic|doctors"](around:${radiusM},${lat},${lng});
      node["amenity"="shelter"](around:${radiusM},${lat},${lng});
      node["social_facility"~"refugee|homeless|outreach"](around:${radiusM},${lat},${lng});
      node["amenity"~"bus_station|taxi"](around:${radiusM},${lat},${lng});
      node["public_transport"="station"](around:${radiusM},${lat},${lng});
      node["amenity"="fire_station"](around:${radiusM},${lat},${lng});
    );
    out center 60;
  `.trim();
}

function classify(tags: Record<string, string> = {}) {
  if (tags.amenity === 'police') return 'police';
  if (tags.amenity === 'fire_station') return 'fire';
  if (['hospital', 'clinic', 'doctors'].includes(tags.amenity || '')) return 'medical';
  if (tags.amenity === 'shelter' || tags.social_facility) return 'shelter';
  if (['bus_station', 'taxi'].includes(tags.amenity || '') || tags.public_transport === 'station') return 'transit';
  return 'other';
}

export async function POST(req: NextRequest) {
  const { caseId, lat, lng, radiusM } = await req.json();
  if (lat == null || lng == null) {
    return NextResponse.json({ error: 'lat and lng required' }, { status: 400 });
  }
  const radius = Number(radiusM) || Number(process.env.INTEL_OVERPASS_RADIUS_M) || 4000;

  const db = getSupa();
  if (caseId) {
    await emit(db, caseId, 'intel.overpass', 'start', {
      status: 'scanning_critical_infrastructure',
      radius_m: radius,
    });
  }

  let nodes: PoiNode[] = [];
  let error: string | null = null;

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Argus def/acc',
      },
      body: 'data=' + encodeURIComponent(buildQuery(Number(lat), Number(lng), radius)),
      cache: 'no-store',
    });
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      nodes = (data.elements || []) as PoiNode[];
    } else {
      error = `overpass ${response.status}`;
    }
  } catch (err: any) {
    error = err?.message || 'overpass network error';
  }

  const pois = nodes
    .map((n) => {
      const plat = n.lat ?? n.center?.lat;
      const plng = n.lon ?? n.center?.lon;
      if (plat == null || plng == null) return null;
      const tags = n.tags || {};
      return {
        id: `${n.type}/${n.id}`,
        kind: classify(tags),
        name: tags.name || tags['name:es'] || tags.operator || tags.amenity || 'POI',
        amenity: tags.amenity,
        phone: tags.phone || tags['contact:phone'] || null,
        lat: Number(plat),
        lng: Number(plng),
      };
    })
    .filter(Boolean) as Array<{ id: string; kind: string; name: string; amenity?: string; phone: string | null; lat: number; lng: number }>;

  const summary = pois.reduce<Record<string, number>>((acc, p) => {
    acc[p.kind] = (acc[p.kind] || 0) + 1;
    return acc;
  }, {});

  if (caseId) {
    await emit(db, caseId, 'intel.overpass', error ? 'error' : 'complete', {
      status: error ? 'overpass_failed' : 'infrastructure_mapped',
      radius_m: radius,
      counts: summary,
      total: pois.length,
      pois: pois.slice(0, 30),
      error,
    });
  }

  return NextResponse.json({
    ok: !error,
    radius_m: radius,
    total: pois.length,
    counts: summary,
    pois,
    error,
  });
}
