import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { withSpan } from '@/lib/trace';

function getSupa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function getMapboxTokens() {
  return [process.env.MAPBOX_TOKEN, process.env.NEXT_PUBLIC_MAPBOX_TOKEN]
    .map((t) => t?.trim())
    .filter(Boolean) as string[];
}

/**
 * Ask Mapbox for up to N candidates and pick the most relevant one.
 * `proximity` biases ranking toward a known city center when we have one.
 */
async function mapboxQuery(query: string, opts: { proximity?: [number, number]; types?: string } = {}) {
  const tokens = getMapboxTokens();
  if (!query || tokens.length === 0) return null;

  const params = new URLSearchParams({
    limit: '5',
    language: 'es',
    country: 'co',
    autocomplete: 'false',
  });
  if (opts.proximity) params.set('proximity', `${opts.proximity[0]},${opts.proximity[1]}`);
  if (opts.types) params.set('types', opts.types);

  for (const token of tokens) {
    params.set('access_token', token);
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?${params.toString()}`;
    const response = await fetch(url).catch(() => null);
    if (!response) continue;
    if (!response.ok) {
      console.warn(`[geocode] token failed status=${response.status} q="${query.slice(0, 60)}"`);
      continue;
    }
    const data = await response.json().catch(() => ({}));
    const features = Array.isArray(data?.features) ? data.features : [];
    if (features.length === 0) return null;
    // Mapbox returns features sorted by relevance, but we keep the best one
    // with a valid center anyway in case the API ranks oddly.
    const best = features
      .filter((f: any) => Array.isArray(f?.center) && f.center.length >= 2)
      .sort((a: any, b: any) => Number(b?.relevance || 0) - Number(a?.relevance || 0))[0];
    if (!best) return null;
    return {
      lon: Number(best.center[0]),
      lat: Number(best.center[1]),
      label: best.place_name || query,
      relevance: Number(best.relevance || 0),
      placeType: Array.isArray(best.place_type) ? best.place_type[0] : null,
    };
  }
  return null;
}

/**
 * Split a free-form Spanish location into (barrio, ciudad). Handles the most
 * common shapes the agent extracts: "barrio Pastrana, Magangué",
 * "Centro de Barranquilla", "Bocagrande, Cartagena", or just a city name.
 */
function parseLocation(raw: string): { barrio: string | null; city: string | null; raw: string } {
  const cleaned = raw.replace(/\s+/g, ' ').trim();

  // "barrio X, ciudad" or "barrio X en ciudad"
  const barrioComma = cleaned.match(/^barrio\s+([^,]+?)\s*(?:,|\s+en\s+)\s*(.+)$/i);
  if (barrioComma) return { barrio: barrioComma[1].trim(), city: barrioComma[2].trim(), raw: cleaned };

  // "centro de ciudad" / "norte de ciudad" — treat sector as barrio
  const sectorOf = cleaned.match(/^(centro|norte|sur|oriente|occidente|este|oeste)\s+de\s+(.+)$/i);
  if (sectorOf) return { barrio: sectorOf[1].trim(), city: sectorOf[2].trim(), raw: cleaned };

  // "X, ciudad" — first chunk is barrio, second is city
  const comma = cleaned.match(/^([^,]+),\s*(.+)$/);
  if (comma) return { barrio: comma[1].trim(), city: comma[2].trim(), raw: cleaned };

  // Plain "barrio X" with no city — barrio only.
  const barrioOnly = cleaned.match(/^barrio\s+(.+)$/i);
  if (barrioOnly) return { barrio: barrioOnly[1].trim(), city: null, raw: cleaned };

  return { barrio: null, city: cleaned, raw: cleaned };
}

async function geocodeLocation(location?: string) {
  if (!location) return null;
  const tokens = getMapboxTokens();
  if (tokens.length === 0) return null;

  const { barrio, city, raw } = parseLocation(location);

  // 1) Anchor on the city first. Without this, "Pastrana" can match a
  //    homonym in another department.
  let cityHit = null as Awaited<ReturnType<typeof mapboxQuery>>;
  if (city) {
    cityHit = await mapboxQuery(`${city}, Colombia`, { types: 'place,locality,district,region' });
  }

  // 2) If we have a barrio + city anchor, query the barrio biased toward
  //    the city center and prefer neighborhood-level results.
  if (barrio && cityHit) {
    const refined = await mapboxQuery(`${barrio}, ${cityHit.label}`, {
      proximity: [cityHit.lon, cityHit.lat],
      types: 'neighborhood,locality,address,poi',
    });
    if (refined && refined.relevance >= 0.5) {
      return {
        gps_lon: refined.lon,
        gps_lat: refined.lat,
        place_label: refined.label,
      };
    }
    // Fall back to the city if the barrio could not be located precisely.
    return { gps_lon: cityHit.lon, gps_lat: cityHit.lat, place_label: cityHit.label };
  }

  // 3) Single city / district query.
  if (cityHit) {
    return { gps_lon: cityHit.lon, gps_lat: cityHit.lat, place_label: cityHit.label };
  }

  // 4) Last resort: raw string with Colombia suffix, no type filter.
  const fallback = await mapboxQuery(raw.toLowerCase().includes('colombia') ? raw : `${raw}, Colombia`);
  if (!fallback) return null;
  return { gps_lon: fallback.lon, gps_lat: fallback.lat, place_label: fallback.label };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return withSpan<NextResponse>('pipeline.orchestrate', { attrs: { method: 'POST' } }, async (span) => {
  const db = getSupa();
  if (!db) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const { caseId, description, photoUrl, authorityEmail } = await req.json();
  if (!caseId) return NextResponse.json({ error: 'No caseId' }, { status: 400 });
  span.attrs.case_id = caseId;
  span.attrs.has_photo = !!photoUrl;
  const geo = await geocodeLocation(description?.ultima_ubicacion);
  const enrichedDescription = geo ? { ...(description || {}), geo } : (description || {});

  // Update case
  await db.from('cases').update({
    description: enrichedDescription,
    portrait_url: photoUrl || null,
    status: photoUrl ? 'searching' : 'portrait',
    updated_at: new Date().toISOString(),
  }).eq('id', caseId);

  await db.from('pipeline_events').insert({
    case_id: caseId, agent: 'agent0', event: 'complete',
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

    // Atlas projects the probable search radius and walks a path outward.
    // Runs in the background so the response stays fast; the map fills in
    // via realtime pipeline_events as Atlas emits zones.
    console.log('[launch-pipeline] Dispatching Atlas projection in background');
    fetch(`${origin}/api/agents/atlas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseId, lat: geo.gps_lat, lng: geo.gps_lon }),
    }).catch((err) => console.error('[launch-pipeline] atlas dispatch:', err.message));

    // Pulse heartbeat — broadcasts the alert zone and notification status.
    fetch(`${origin}/api/agents/pulse-watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        caseId,
        lat: geo.gps_lat,
        lng: geo.gps_lon,
        channels: ['whatsapp', 'email'],
      }),
    }).catch((err) => console.error('[launch-pipeline] pulse dispatch:', err.message));

    // Sentinel scans for clusters across the recent matches. Delayed so
    // Ghost has had a chance to drop matches first.
    setTimeout(() => {
      fetch(`${origin}/api/agents/sentinel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId }),
      }).catch((err) => console.error('[launch-pipeline] sentinel dispatch:', err.message));
    }, 8000);

    // OSINT enrichment: GDELT + OSM Overpass. Both fire in parallel,
    // results land as pipeline_events the dashboard renders as the
    // Context + Critical-infrastructure layers (defensive intel core).
    fetch(`${origin}/api/intel/gdelt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseId, lat: geo.gps_lat, lng: geo.gps_lon }),
    }).catch((err) => console.error('[launch-pipeline] gdelt dispatch:', err.message));

    fetch(`${origin}/api/intel/overpass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseId, lat: geo.gps_lat, lng: geo.gps_lon }),
    }).catch((err) => console.error('[launch-pipeline] overpass dispatch:', err.message));

    // Family WhatsApp ping — alerts the reporter that the search is live.
    // Reads reporter_phone from the case row (set by /api/cases/demo).
    try {
      const { data: kase } = await db.from('cases').select('reporter_phone').eq('id', caseId).single();
      const reporterPhone = (kase as any)?.reporter_phone;
      if (reporterPhone && reporterPhone !== 'web-agent') {
        fetch(`${origin}/api/whatsapp/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            caseId,
            to: reporterPhone,
            kind: 'alert',
            text:
              `🛰️ ARGUS activado para ${enrichedDescription.nombre || 'tu caso'}.\n` +
              `Última ubicación: ${geo.place_label}.\n` +
              `Agentes desplegados. Te aviso si hay coincidencia.\n` +
              `Mapa en vivo: ${origin}/`,
          }),
        }).catch((err) => console.error('[launch-pipeline] wa family dispatch:', err.message));
      }
    } catch {}
  }

  // Ghost.social — public-only social OSINT (adapted from auto-social).
  // Runs independent of geo, just needs a name. Defensive note: we only
  // query public-indexed posts, no login, no scraping behind walls.
  if (enrichedDescription?.nombre) {
    fetch(`${origin}/api/osint/social`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseId, description: enrichedDescription }),
    }).catch((err) => console.error('[launch-pipeline] osint.social dispatch:', err.message));
  }

  console.log(`[launch-pipeline] case=${caseId} photo=${!!photoUrl}`);

  // Anclaje Filecoin/IPFS — manifiesto inicial del caso (fire-and-forget).
  // Se completará con un re-anchor posterior cuando haya más eventos.
  fetch(`${origin}/api/case/anchor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caseId }),
  }).catch((err) => console.error('[launch-pipeline] anchor dispatch:', err.message));

  const mapUrl = geo ? `https://www.google.com/maps/search/?api=1&query=${geo.gps_lat},${geo.gps_lon}` : undefined;
  const result: Record<string, any> = { publish: null, alert: null, video: null, search: null };

  try {
    console.log('[launch-pipeline] Publishing to Facebook...');
    const publishRes = await fetch(`${origin}/api/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseId }),
    });
    result.publish = await publishRes.json().catch(() => ({ ok: false, error: 'Invalid publish JSON' }));
    console.log(`[launch-pipeline] Publish done status=${publishRes.status} fb=${JSON.stringify(result.publish.facebook || {}).slice(0, 220)}`);

    const alertRes = await fetch(`${origin}/api/alert-authorities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        caseId,
        authorityEmail,
        description: enrichedDescription,
        photoUrl,
        bannerUrl,
        mapUrl,
        match: {
          location: geo?.place_label || description?.ultima_ubicacion || 'Zona reportada',
          confidence: 0.65,
          ...(geo || {}),
        },
      }),
    });
    result.alert = await alertRes.json().catch(() => ({ ok: false, error: 'Invalid alert JSON' }));
    console.log(`[launch-pipeline] Alert done status=${alertRes.status}`);

    if (process.env.MINIMAX_ENABLED === 'true') {
      const videoRes = await fetch(`${origin}/api/minimax/video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId }),
      });
      result.video = await videoRes.json().catch(() => ({ ok: false, error: 'Invalid video JSON' }));
      console.log(`[launch-pipeline] MiniMax video status=${videoRes.status} task=${result.video?.task_id || 'none'}`);
    }

    if (photoUrl) {
      // Vision search can take 30-60s+ (one Gemini/MiniMax call per photo). Fire it
      // in the background so the UI gets a fast response and watches pipeline_events
      // in realtime. publish-found is triggered from inside search on the first match.
      console.log('[launch-pipeline] Dispatching vision search in background');
      fetch(`${origin}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId, authorityEmail }),
      }).catch((err) => console.error('[launch-pipeline] search dispatch failed:', err.message));
      result.search = { dispatched: true, mode: 'background' };
    }
  } catch (err: any) {
    console.error('[launch-pipeline] Pipeline error:', err.message);
    result.error = err.message;
    await db.from('pipeline_events').insert({
      case_id: caseId,
      agent: 'pipeline',
      event: 'error',
      payload: { status: 'pipeline_failed', error: err.message },
    });
  }

  return NextResponse.json({ ok: !result.error, geo, bannerUrl, ...result });
  });
}
