import { NextRequest, NextResponse } from 'next/server';
import { getSupa, emit, sleep } from '@/lib/argus-server';
import { clusterByDistance, haversineKm, type LatLng } from '@/lib/geo';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Sentinel — cluster + pattern detector.
 *
 * Looks at:
 *   - recent matches (sightings) in the last 72h
 *   - recent CASES (new reports) in the last 7d
 *
 * Emits three classes of pipeline events:
 *
 *   - cluster_detected: ≥2 sightings in <1.2km. Red zone on the map.
 *   - trafficking_pattern_alert: ≥3 cases in <5km within 7d with overlapping
 *     demographics (gender, age band). High-severity badge in the Defense
 *     Posture panel.
 *   - false_report_cluster: ≥2 cases from the same reporter_phone in 24h.
 *     Surfaces a yellow integrity warning so the operator can triage.
 *
 * Defense angle (def/acc): clusters that hint at trafficking rings get
 * surfaced to the operator before any single case can mask the pattern.
 */

const AGE_BAND = (age: number | null | undefined): string => {
  if (!Number.isFinite(age as number)) return 'unknown';
  const a = Number(age);
  if (a < 13) return 'child';
  if (a < 18) return 'minor';
  if (a < 30) return 'young_adult';
  if (a < 55) return 'adult';
  return 'senior';
};

interface CaseRow {
  id: string;
  reporter_phone: string | null;
  description: any;
  created_at: string;
}

interface SightingRow {
  case_id: string;
  gps_lat: number;
  gps_lon: number;
  confidence: number | null;
  created_at: string;
}

function nowMinus(hours: number) {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

export async function POST(req: NextRequest) {
  const db = getSupa();
  if (!db) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const { caseId } = await req.json();
  if (!caseId) return NextResponse.json({ error: 'caseId required' }, { status: 400 });

  await emit(db, caseId, 'sentinel', 'start', { status: 'scanning_anomalies' });

  // ---- 1. Sightings clusters (existing behavior, hardened) ----
  let sightings: SightingRow[] = [];
  try {
    const { data } = await db
      .from('matches')
      .select('case_id,gps_lat,gps_lon,confidence,created_at')
      .gte('created_at', nowMinus(72))
      .not('gps_lat', 'is', null)
      .not('gps_lon', 'is', null)
      .limit(300);
    sightings = (data || []) as SightingRow[];
  } catch (err: any) {
    await emit(db, caseId, 'sentinel', 'error', { error: err?.message || 'unknown', stage: 'sightings' });
  }

  const points: LatLng[] = sightings.map((m) => ({ lat: Number(m.gps_lat), lng: Number(m.gps_lon) }));
  const clusters = clusterByDistance(points, 1.2).filter((c) => c.size >= 2);

  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    await emit(db, caseId, 'sentinel', 'progress', {
      status: 'cluster_detected',
      cluster_index: i,
      cluster_size: c.size,
      severity: Math.min(1, 0.4 + c.size * 0.15),
      zone: {
        label: `Anomalia ${i + 1} (${c.size} senales)`,
        lat: c.centroid.lat,
        lng: c.centroid.lng,
        radius_km: 1.1,
      },
      agent_position: { lat: c.centroid.lat, lng: c.centroid.lng },
    });
    await sleep(220);
  }

  // ---- 2. Case-level pattern scan ----
  let cases: CaseRow[] = [];
  try {
    const { data } = await db
      .from('cases')
      .select('id,reporter_phone,description,created_at')
      .gte('created_at', nowMinus(7 * 24))
      .limit(120);
    cases = (data || []) as CaseRow[];
  } catch (err: any) {
    await emit(db, caseId, 'sentinel', 'error', { error: err?.message, stage: 'cases' });
  }

  const enriched = cases
    .map((c) => {
      const desc = c.description || {};
      const geo = desc.geo || {};
      return {
        id: c.id,
        reporter_phone: c.reporter_phone || '',
        created_at: c.created_at,
        gender: String(desc.genero || '').toLowerCase() || 'unknown',
        ageBand: AGE_BAND(desc.edad_aprox),
        lat: Number(geo.gps_lat),
        lng: Number(geo.gps_lon),
      };
    })
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));

  // Trafficking pattern: ≥3 cases within 5km with overlapping demographics.
  const trafficking: { lat: number; lng: number; cases: string[]; gender: string; ageBand: string }[] = [];
  for (let i = 0; i < enriched.length; i++) {
    const seed = enriched[i];
    const group = enriched.filter(
      (c) =>
        c.id !== seed.id &&
        c.gender === seed.gender &&
        c.ageBand === seed.ageBand &&
        haversineKm({ lat: seed.lat, lng: seed.lng }, { lat: c.lat, lng: c.lng }) <= 5,
    );
    if (group.length >= 2) {
      const all = [seed, ...group];
      const lat = all.reduce((s, x) => s + x.lat, 0) / all.length;
      const lng = all.reduce((s, x) => s + x.lng, 0) / all.length;
      const ids = all.map((x) => x.id).sort();
      const dupe = trafficking.find((t) => t.cases.join() === ids.join());
      if (!dupe) {
        trafficking.push({ lat, lng, cases: ids, gender: seed.gender, ageBand: seed.ageBand });
      }
    }
  }

  for (const t of trafficking) {
    await emit(db, caseId, 'sentinel', 'progress', {
      status: 'trafficking_pattern_alert',
      severity: 0.92,
      pattern: 'human_trafficking_suspect',
      cases_in_pattern: t.cases.length,
      gender: t.gender,
      age_band: t.ageBand,
      zone: {
        label: `Patron ${t.gender}/${t.ageBand} (${t.cases.length} casos)`,
        lat: t.lat,
        lng: t.lng,
        radius_km: 5,
      },
      agent_position: { lat: t.lat, lng: t.lng },
    });
    await sleep(220);
  }

  // False-report cluster: same phone reporting ≥2 cases in 24h.
  const phoneCounts = new Map<string, CaseRow[]>();
  for (const c of cases) {
    if (!c.reporter_phone) continue;
    const recent = new Date(c.created_at).getTime() > Date.now() - 24 * 3_600_000;
    if (!recent) continue;
    if (!phoneCounts.has(c.reporter_phone)) phoneCounts.set(c.reporter_phone, []);
    phoneCounts.get(c.reporter_phone)!.push(c);
  }
  const suspicious = Array.from(phoneCounts.entries()).filter(([phone, list]) => phone !== 'web-agent' && list.length >= 2);
  for (const [phone, list] of suspicious) {
    await emit(db, caseId, 'sentinel', 'progress', {
      status: 'false_report_cluster',
      severity: 0.5,
      pattern: 'integrity_warning',
      reporter_phone: phone.slice(-4).padStart(phone.length, '*'),
      cases_in_pattern: list.length,
    });
  }

  await emit(db, caseId, 'sentinel', 'complete', {
    status: 'sweep_complete',
    clusters_found: clusters.length,
    trafficking_patterns: trafficking.length,
    integrity_warnings: suspicious.length,
    sample: { sightings: sightings.length, cases: cases.length },
  });

  return NextResponse.json({
    ok: true,
    clusters_found: clusters.length,
    trafficking_patterns: trafficking.length,
    integrity_warnings: suspicious.length,
  });
}
