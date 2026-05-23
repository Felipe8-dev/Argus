import { NextRequest, NextResponse } from 'next/server';
import { emit, getSupa } from '@/lib/argus-server';
import { harvestPost } from '@/lib/harvest';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/osint/harvest
 *
 * Body: { caseId, postUrl, authorityEmail?, autoNotify? }
 *
 * Reads comments from a publication the operator already controls (the
 * post the operator/family published) and scores each comment for
 * sighting intent. High-scoring comments become matches that drive the
 * rest of the pipeline (map markers, alerts, etc).
 *
 * Defensive note (def/acc): we don't impersonate, don't bypass walls,
 * and only read comments on posts the operator owns. The post URL is
 * supplied by the operator after they (or /api/publish) created it.
 */
export async function POST(req: NextRequest) {
  const { caseId, postUrl, authorityEmail, autoNotify = true } = await req.json();
  if (!postUrl) {
    return NextResponse.json({ error: 'postUrl required' }, { status: 400 });
  }

  const db = getSupa();
  if (caseId) {
    await emit(db, caseId, 'ghost.harvest', 'start', {
      status: 'reading_comments',
      postUrl,
    });
  }

  const result = await harvestPost(postUrl);

  if (caseId) {
    await emit(db, caseId, 'ghost.harvest', result.ok ? 'progress' : 'error', {
      status: result.ok ? 'comments_scored' : 'harvest_failed',
      platform: result.platform,
      post_id: result.post_id,
      total_comments: result.total,
      sightings: result.scored.length,
      error: result.error,
      hint: result.hint,
    });
  }

  // Insert high-confidence sightings as matches so the operational map
  // surfaces them next to vision matches. authorityEmail is fired
  // automatically when score ≥ 0.75 and autoNotify is on.
  let inserted = 0;
  let notified = false;
  if (db && caseId && result.scored.length) {
    let geo: { lat: number; lng: number; place_label?: string } | null = null;
    try {
      const { data: kase } = await db.from('cases').select('description,portrait_url').eq('id', caseId).single();
      const g = (kase as any)?.description?.geo;
      if (g && Number.isFinite(g.gps_lat) && Number.isFinite(g.gps_lon)) {
        geo = { lat: g.gps_lat, lng: g.gps_lon, place_label: g.place_label };
      }
    } catch {}

    for (const c of result.scored.slice(0, 20)) {
      try {
        const { data } = await db
          .from('matches')
          .insert({
            case_id: caseId,
            source_url: c.source_url,
            source_site: `harvest:${c.platform}`,
            photo_url: c.source_url,
            confidence: c.score,
            reasoning: `Witness tip (${c.author_name}): ${c.text.slice(0, 200)}`,
            gps_lat: geo?.lat ?? null,
            gps_lon: geo?.lng ?? null,
            place_label: geo?.place_label ?? null,
          })
          .select()
          .single();
        if (data?.id) inserted++;

        if (!notified && autoNotify && c.score >= 0.75) {
          const origin = req.nextUrl.origin;
          notified = true;
          fetch(`${origin}/api/alert-authorities`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              caseId,
              authorityEmail,
              kind: 'found',
              match: {
                ...(geo || {}),
                confidence: c.score,
                source_site: `harvest:${c.platform}`,
                source_url: c.source_url,
                place_label: geo?.place_label,
              },
            }),
          }).catch(() => {});
        }
      } catch {
        // each insert is best-effort
      }
    }
  }

  if (caseId) {
    await emit(db, caseId, 'ghost.harvest', 'complete', {
      status: 'harvest_complete',
      platform: result.platform,
      total_comments: result.total,
      sightings: result.scored.length,
      matches_inserted: inserted,
      authority_notified: notified,
    });
  }

  return NextResponse.json({
    ok: result.ok,
    platform: result.platform,
    postUrl,
    post_id: result.post_id,
    total_comments: result.total,
    sightings: result.scored,
    matches_inserted: inserted,
    authority_notified: notified,
    error: result.error,
    hint: result.hint,
  });
}
