import { NextRequest, NextResponse } from 'next/server';
import { getSupa } from '@/lib/argus-server';
import { health, isConfigured, syncState } from '@/lib/struere';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/intel/posture
 *
 * Single aggregated snapshot for the Defense Posture panel:
 *   - case throughput in last 24h / 7d
 *   - agent activity (pipeline_events grouped by agent)
 *   - intel signals (GDELT articles, Overpass POIs, provenance verdicts)
 *   - sentinel threat patterns (trafficking, integrity warnings)
 *   - Struere wiring (live or unconfigured)
 *
 * Designed to be polled by the dashboard / landing every few seconds.
 */

type Counts = Record<string, number>;

function bumpCount(map: Counts, key: string, by = 1) {
  map[key] = (map[key] || 0) + by;
}

export async function GET(_req: NextRequest) {
  const db = getSupa();

  const empty = {
    cases: { total: 0, last_24h: 0, last_7d: 0, by_status: {} as Counts },
    agents: {} as Record<string, { active: number; completed: number; error: number }>,
    intel: {
      provenance: { verified: 0, suspect: 0, unknown: 0 },
      gdelt_articles: 0,
      overpass_pois: 0,
    },
    sentinel: {
      cluster_alerts: 0,
      trafficking_patterns: 0,
      integrity_warnings: 0,
      latest_patterns: [] as any[],
    },
    struere: null as any,
    last_events: [] as any[],
  };

  if (!db) {
    return NextResponse.json({ ok: false, error: 'supabase_not_configured', posture: empty });
  }

  const since24h = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const since7d = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();

  // Parallel reads to keep the panel snappy.
  const [casesRes, eventsRes, struereStateRes, struereHealthRes] = await Promise.all([
    db.from('cases').select('id,status,created_at').gte('created_at', since7d).limit(500),
    db.from('pipeline_events').select('agent,event,payload,created_at').gte('created_at', since7d).order('created_at', { ascending: false }).limit(500),
    isConfigured() ? syncState() : Promise.resolve(null),
    isConfigured() ? health() : Promise.resolve(null),
  ]);

  const cases = (casesRes.data || []) as Array<{ id: string; status: string; created_at: string }>;
  const events = (eventsRes.data || []) as Array<{ agent: string; event: string; payload: any; created_at: string }>;

  const posture = JSON.parse(JSON.stringify(empty));

  posture.cases.total = cases.length;
  for (const c of cases) {
    bumpCount(posture.cases.by_status, c.status || 'unknown');
    if (new Date(c.created_at).toISOString() >= since24h) posture.cases.last_24h++;
    posture.cases.last_7d++;
  }

  for (const e of events) {
    const slot = (posture.agents[e.agent] ||= { active: 0, completed: 0, error: 0 });
    if (e.event === 'complete') slot.completed++;
    else if (e.event === 'error') slot.error++;
    else slot.active++;

    if (e.agent === 'intel.provenance' && e.event === 'complete') {
      const v = String(e.payload?.verdict || 'unknown');
      if (v === 'verified') posture.intel.provenance.verified++;
      else if (v === 'suspect') posture.intel.provenance.suspect++;
      else posture.intel.provenance.unknown++;
    }
    if (e.agent === 'intel.gdelt' && e.event === 'complete') {
      posture.intel.gdelt_articles += Number(e.payload?.count || 0);
    }
    if (e.agent === 'intel.overpass' && e.event === 'complete') {
      posture.intel.overpass_pois += Number(e.payload?.total || 0);
    }
    if (e.agent === 'sentinel') {
      const status = String(e.payload?.status || '');
      if (status === 'cluster_detected') posture.sentinel.cluster_alerts++;
      if (status === 'trafficking_pattern_alert') {
        posture.sentinel.trafficking_patterns++;
        if (posture.sentinel.latest_patterns.length < 5) {
          posture.sentinel.latest_patterns.push({
            at: e.created_at,
            gender: e.payload?.gender,
            age_band: e.payload?.age_band,
            cases: e.payload?.cases_in_pattern,
            zone: e.payload?.zone,
          });
        }
      }
      if (status === 'false_report_cluster') posture.sentinel.integrity_warnings++;
    }
  }

  posture.last_events = events.slice(0, 12).map((e) => ({
    agent: e.agent,
    event: e.event,
    status: e.payload?.status,
    severity: e.payload?.severity,
    at: e.created_at,
  }));

  if (struereStateRes) {
    const s = struereStateRes.data as any;
    posture.struere = {
      configured: true,
      ok: struereStateRes.ok,
      health: (struereHealthRes as any)?.data || null,
      counts: s
        ? {
            agents: s.agents?.length || 0,
            routers: s.routers?.length || 0,
            tools: s.tools?.length || 0,
            triggers: s.triggers?.length || 0,
            entityTypes: s.entityTypes?.length || 0,
          }
        : null,
      error: struereStateRes.error,
    };
  } else {
    posture.struere = { configured: false };
  }

  return NextResponse.json({ ok: true, posture, generated_at: new Date().toISOString() });
}
