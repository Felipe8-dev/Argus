import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

function getSupa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * POST /api/sighting/manual
 * Body: { caseId, lat, lng, note?, confidence? }
 *
 * El operador marca manualmente un avistamiento en el mapa.
 * Se inserta como match con source_site='operator-manual' y
 * confidence alta por default. Si supera 0.75 dispara publish-found.
 */
export async function POST(req: NextRequest) {
  const db = getSupa();
  if (!db) return NextResponse.json({ ok: false, error: 'supabase_unconfigured' }, { status: 500 });

  const { caseId, lat, lng, note, confidence, placeLabel } = await req.json();
  if (!caseId) return NextResponse.json({ ok: false, error: 'caseId required' }, { status: 400 });
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ ok: false, error: 'lat/lng required' }, { status: 400 });
  }

  const conf = Math.max(0, Math.min(1, Number(confidence ?? 0.85)));
  const label = (placeLabel || note || `manual pin (${lat.toFixed(4)}, ${lng.toFixed(4)})`).slice(0, 200);

  const { data: kase } = await db.from('cases').select('portrait_url, description').eq('id', caseId).single();

  const { data: inserted, error } = await db.from('matches').insert({
    case_id: caseId,
    confidence: conf,
    place_label: label,
    gps_lat: lat,
    gps_lon: lng,
    source_site: 'operator-manual',
    source_url: null,
    photo_url: kase?.portrait_url || null,
  }).select().single();

  if (error) {
    console.error('[sighting/manual] insert failed:', error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  await db.from('pipeline_events').insert({
    case_id: caseId,
    agent: 'agent2',
    event: 'complete',
    payload: {
      step: 'manual_sighting',
      operator: true,
      match_id: inserted?.id,
      lat, lng, confidence: conf,
      note: note || null,
    },
  });

  // Trigger publish-found si pasa el umbral.
  if (conf >= 0.75 && inserted?.id) {
    const origin = req.nextUrl.origin;
    fetch(`${origin}/api/publish-found`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseId, matchId: inserted.id }),
    }).catch((err) => console.error('[sighting/manual] publish-found dispatch:', err?.message));
  }

  return NextResponse.json({ ok: true, match: inserted });
}
