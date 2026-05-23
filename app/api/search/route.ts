import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { compareImages } from '@/lib/vision';
import { sleep } from '@/lib/argus-server';

const MIN_CONFIDENCE = Number(process.env.SEARCH_MIN_CONFIDENCE || 0.55);
const FOUND_NOTIFY_THRESHOLD = Number(process.env.FOUND_NOTIFY_THRESHOLD || 0.75);

function getSupa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function POST(req: NextRequest) {
  const db = getSupa();
  if (!db) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const { caseId, authorityEmail } = await req.json();
  if (!caseId) return NextResponse.json({ error: 'No caseId' }, { status: 400 });

  const { data: kase } = await db.from('cases').select('*').eq('id', caseId).single();
  if (!kase) return NextResponse.json({ error: 'Case not found' }, { status: 404 });

  const portraitUrl = kase.portrait_url;
  if (!portraitUrl) return NextResponse.json({ error: 'No portrait/photo for this case' }, { status: 400 });

  const desc = kase.description || {};
  const origin = req.nextUrl.origin;

  await db.from('pipeline_events').insert({
    case_id: caseId,
    agent: 'agent2',
    event: 'start',
    payload: { step: 'vision_search', min_confidence: MIN_CONFIDENCE, notify_threshold: FOUND_NOTIFY_THRESHOLD },
  });

  const photosRes = await fetch(`${origin}/api/photos`, { cache: 'no-store' });
  if (!photosRes.ok) return NextResponse.json({ error: 'Cannot fetch photos' }, { status: 500 });
  const photos = await photosRes.json() as Array<{
    url: string;
    source_site: string;
    source_page: string;
    posted_by: string;
    posted_at: string;
    gps_lat?: number;
    gps_lon?: number;
    place_label?: string;
  }>;

  await db.from('pipeline_events').insert({
    case_id: caseId,
    agent: 'agent2',
    event: 'progress',
    payload: { total_photos: photos.length, status: 'scanning_focused_sources' },
  });

  const matches: any[] = [];
  let notified = false;

  // Origin for the cinematic walk: case's last-known location. Each photo
  // gets ~5 interpolated waypoints so Ghost visibly *walks* toward the
  // discovery instead of teleporting.
  const caseGeo = (kase as any)?.description?.geo;
  const origin_lat = Number(caseGeo?.gps_lat);
  const origin_lng = Number(caseGeo?.gps_lon);
  const hasOrigin = Number.isFinite(origin_lat) && Number.isFinite(origin_lng);

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];

    // Emit a scanning zone before each photo so the live map shows where
    // Ghost is currently sweeping. radius_km is small so several zones
    // can co-exist without overlapping the whole city.
    if (photo.gps_lat && photo.gps_lon) {
      await db.from('pipeline_events').insert({
        case_id: caseId,
        agent: 'agent2',
        event: 'progress',
        payload: {
          status: 'scanning_source_zone',
          photo_index: i,
          total_photos: photos.length,
          source_site: photo.source_site,
          posted_by: photo.posted_by,
          zone: {
            label: `${photo.source_site} · ${photo.posted_by}`,
            lat: Number(photo.gps_lat),
            lng: Number(photo.gps_lon),
            radius_km: 0.5,
          },
          agent_position: { lat: Number(photo.gps_lat), lng: Number(photo.gps_lon) },
        },
      });
      await sleep(150);

      // Cinematic walk: interpolate from the case origin (or previous photo)
      // toward this photo so the map shows the ghost agent *moving in*.
      const startLat = hasOrigin ? origin_lat : Number(photos[i - 1]?.gps_lat ?? photo.gps_lat);
      const startLng = hasOrigin ? origin_lng : Number(photos[i - 1]?.gps_lon ?? photo.gps_lon);
      const steps = 6;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const lat = startLat + (Number(photo.gps_lat) - startLat) * t;
        const lng = startLng + (Number(photo.gps_lon) - startLng) * t;
        await db.from('pipeline_events').insert({
          case_id: caseId,
          agent: 'agent2',
          event: 'progress',
          payload: {
            status: 'walking_to_source',
            photo_index: i,
            walk_step: s,
            walk_total: steps,
            agent_position: { lat, lng },
          },
        });
        await sleep(220);
      }
    }

    await db.from('pipeline_events').insert({
      case_id: caseId,
      agent: 'agent2',
      event: 'progress',
      payload: {
        status: 'analyzing_photo',
        photo_index: i,
        total_photos: photos.length,
        photo_url: photo.url,
        source_site: photo.source_site,
        posted_by: photo.posted_by,
      },
    });

    try {
      const verdict = await compareImages(desc, portraitUrl, photo.url);

      await db.from('pipeline_events').insert({
        case_id: caseId,
        agent: 'agent2',
        event: 'progress',
        payload: {
          status: 'photo_analyzed',
          photo_index: i,
          total_photos: photos.length,
          photo_url: photo.url,
          confidence: verdict.confidence,
          provider: verdict.provider,
          is_match: verdict.confidence >= MIN_CONFIDENCE,
          gps_lat: photo.gps_lat,
          gps_lon: photo.gps_lon,
          place_label: photo.place_label,
        },
      });

      if (verdict.confidence >= MIN_CONFIDENCE) {
        const matchRow = {
          case_id: caseId,
          source_url: photo.source_page,
          source_site: photo.source_site,
          photo_url: photo.url,
          confidence: verdict.confidence,
          reasoning: verdict.reasoning || '',
          gps_lat: photo.gps_lat || null,
          gps_lon: photo.gps_lon || null,
          place_label: photo.place_label || null,
        };

        const { data: inserted } = await db.from('matches').insert(matchRow).select().single();
        matches.push({ ...matchRow, id: inserted?.id });

        // First strong match: trigger publish-found + email notification immediately.
        // We do this fire-and-forget so the rest of the sweep keeps going.
        if (!notified && inserted?.id && verdict.confidence >= FOUND_NOTIFY_THRESHOLD) {
          notified = true;
          fetch(`${origin}/api/publish-found`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ caseId, matchId: inserted.id, authorityEmail }),
          }).catch((err) => {
            console.error('[search] publish-found trigger failed:', err.message);
          });
        }
      }
    } catch (err: any) {
      await db.from('pipeline_events').insert({
        case_id: caseId,
        agent: 'agent2',
        event: 'error',
        payload: {
          status: 'photo_failed',
          photo_index: i,
          photo_url: photo.url,
          error: err.message,
        },
      });
    }
  }

  await db.from('cases').update({
    status: matches.length > 0 ? 'match_found' : 'searching',
    updated_at: new Date().toISOString(),
  }).eq('id', caseId);

  await db.from('pipeline_events').insert({
    case_id: caseId,
    agent: 'agent2',
    event: 'complete',
    payload: { matches_found: matches.length, found_notification_sent: notified },
  });

  return NextResponse.json({ matches: matches.length, results: matches, notified });
}
