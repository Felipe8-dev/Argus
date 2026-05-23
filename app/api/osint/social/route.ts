import { NextRequest, NextResponse } from 'next/server';
import { emit, getSupa } from '@/lib/argus-server';
import { findPublicSightings, type SightingCandidate } from '@/lib/social-osint';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Ghost.social — public-only social OSINT for missing-person sightings.
 *
 * Adapted from the operator's auto-social engine but flipped from
 * "purchase intent" → "sighting intent". We never log in, never
 * impersonate, never bypass walls — only indexed public posts.
 *
 * Emits pipeline_events as `ghost.social` so the live map can render the
 * candidates as zone scans and the operator can audit every URL the
 * engine surfaces.
 *
 * Optional Supabase upsert: high-confidence sighting candidates (≥0.7)
 * are inserted into `matches` so they show up on the operational map
 * alongside vision matches.
 */
export async function POST(req: NextRequest) {
  const { caseId, description, perPlatform, minScore } = await req.json();
  if (!description?.nombre) {
    return NextResponse.json({ error: 'description.nombre required' }, { status: 400 });
  }

  const db = getSupa();
  const personName = String(description.nombre).trim();
  const city = description?.ultima_ubicacion
    ? String(description.ultima_ubicacion).split(',')[0].trim()
    : undefined;

  if (caseId) {
    await emit(db, caseId, 'ghost.social', 'start', {
      status: 'scanning_public_sightings',
      person: personName,
      city,
    });
  }

  let candidates: SightingCandidate[] = [];
  let source: string = 'none';
  let error: string | null = null;
  try {
    const result = await findPublicSightings(
      {
        personName,
        city,
        ropa: description?.ropa,
        edad: description?.edad_aprox,
      },
      { perPlatform: perPlatform || 5, minScore: minScore ?? 0.4 },
    );
    candidates = result.candidates;
    source = result.source;
  } catch (err: any) {
    error = err?.message || 'osint_failed';
  }

  // Emit a per-platform breakdown so the dashboard can show counts.
  const byPlatform = candidates.reduce<Record<string, number>>((acc, c) => {
    acc[c.platform] = (acc[c.platform] || 0) + 1;
    return acc;
  }, {});

  if (caseId) {
    await emit(db, caseId, 'ghost.social', error ? 'error' : 'progress', {
      status: error ? 'osint_failed' : 'candidates_ranked',
      candidates_total: candidates.length,
      by_platform: byPlatform,
      source,
      error,
    });
  }

  // Insert top-scoring candidates as matches so the operational map shows
  // them next to vision matches. We tag them as "osint-social" so the
  // operator can filter them out if they want vision-only.
  const inserted: string[] = [];
  if (db && caseId) {
    const strong = candidates.filter((c) => c.score >= 0.7).slice(0, 8);
    for (const c of strong) {
      try {
        const { data } = await db
          .from('matches')
          .insert({
            case_id: caseId,
            source_url: c.url,
            source_site: `osint:${c.platform}`,
            photo_url: c.url, // social posts: link to the post itself
            confidence: c.score,
            reasoning: `OSINT social: ${c.matchedKeywords.join(', ') || 'sighting signal'}`,
          })
          .select()
          .single();
        if (data?.id) inserted.push(data.id);
      } catch {
        // skip; logged via pipeline_events anyway
      }
    }
  }

  if (caseId) {
    await emit(db, caseId, 'ghost.social', 'complete', {
      status: 'osint_sweep_complete',
      candidates_total: candidates.length,
      matches_inserted: inserted.length,
    });
  }

  return NextResponse.json({
    ok: !error,
    source,
    candidates,
    by_platform: byPlatform,
    matches_inserted: inserted.length,
    error,
    hint: source === 'none' && !error
      ? 'No SERP source returned results. Set BRAVE_SEARCH_API_KEY or SERPER_API_KEY for reliable indexing.'
      : undefined,
  });
}
