import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { withSpan } from '@/lib/trace';
import { geocodeLocation } from '@/lib/orchestration/geocode';
import { runArgusPipeline } from '@/lib/orchestration/graph';

function getSupa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Pipeline entrypoint.
 *
 * The orchestration itself now lives in the LangGraph StateGraph
 * (`lib/orchestration/graph.ts`). This route only does the work that must be
 * synchronous for a fast client response — resolve the location and persist
 * the case — then kicks off the graph in the background. Per-agent progress
 * streams to the client via `pipeline_events` (Supabase Realtime), exactly as
 * before.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return withSpan<NextResponse>('pipeline.orchestrate', { attrs: { method: 'POST' } }, async (span) => {
    const db = getSupa();
    if (!db) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

    const { caseId, description, photoUrl, authorityEmail } = await req.json();
    if (!caseId) return NextResponse.json({ error: 'No caseId' }, { status: 400 });
    span.attrs.case_id = caseId;
    span.attrs.has_photo = !!photoUrl;

    const geo = await geocodeLocation(description?.ultima_ubicacion);
    const enrichedDescription = geo ? { ...(description || {}), geo } : description || {};

    await db
      .from('cases')
      .update({
        description: enrichedDescription,
        portrait_url: photoUrl || null,
        status: photoUrl ? 'searching' : 'portrait',
        updated_at: new Date().toISOString(),
      })
      .eq('id', caseId);

    await db.from('pipeline_events').insert({
      case_id: caseId,
      agent: 'agent0',
      event: 'complete',
      payload: { source: 'web-agent', nombre: description?.nombre, ...(geo || {}) },
    });

    const origin = req.nextUrl.origin;
    const bannerUrl = `${origin}/api/banner/${caseId}`;

    if (geo) {
      await db.from('pipeline_events').insert({
        case_id: caseId,
        agent: 'pipeline',
        event: 'progress',
        payload: {
          status: 'last_seen_geocoded',
          step: 'geocoding',
          zone: { label: 'Última ubicación', lat: geo.gps_lat, lng: geo.gps_lon, radius_km: 1.2 },
          agent_position: { lat: geo.gps_lat, lng: geo.gps_lon },
          ...geo,
        },
      });
    }

    await db.from('pipeline_events').insert({
      case_id: caseId,
      agent: 'pipeline',
      event: 'start',
      payload: { status: 'orchestration_started', engine: 'langgraph' },
    });

    // Hand off to the LangGraph orchestrator. Fire-and-forget so the UI gets a
    // fast response and watches pipeline_events in realtime; the graph runs
    // every agent (provenance → publish → alert → vision → sentinel → anchor,
    // plus the parallel atlas/intel/osint/pulse branches) to completion.
    runArgusPipeline({
      caseId,
      description: enrichedDescription,
      photoUrl: photoUrl || null,
      authorityEmail,
      origin,
      bannerUrl,
      geo,
    }).catch(async (err: any) => {
      console.error('[launch-pipeline] graph error:', err?.message);
      await db.from('pipeline_events').insert({
        case_id: caseId,
        agent: 'pipeline',
        event: 'error',
        payload: { status: 'pipeline_failed', error: err?.message },
      });
    });

    console.log(`[launch-pipeline] case=${caseId} photo=${!!photoUrl} → langgraph dispatched`);

    return NextResponse.json({
      ok: true,
      engine: 'langgraph',
      dispatched: true,
      geo,
      bannerUrl,
    });
  });
}
