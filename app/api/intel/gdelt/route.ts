import { NextRequest, NextResponse } from 'next/server';
import { emit, getSupa } from '@/lib/argus-server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GDELT 2.0 OSINT enrichment.
 *
 * GDELT is a public global event database (https://www.gdeltproject.org/).
 * For every case we query the DOC 2.0 API for news articles matching
 * defensive-context terms ("desaparecida", "trata", "violencia") in a 24h
 * window near the last-seen location. Results are emitted as a
 * `intel.gdelt` pipeline event so the dashboard surfaces real-world
 * context the operator can act on.
 *
 * No API key required. Soft-fails when GDELT is down (returns ok with
 * articles: []).
 */

const DEFAULT_KEYWORDS = [
  'desaparecido',
  'desaparecida',
  'trata de personas',
  'violencia',
  'secuestro',
  'feminicidio',
];

const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';

interface GdeltArticle {
  url: string;
  url_mobile?: string;
  title: string;
  seendate: string;
  socialimage?: string;
  domain: string;
  language: string;
  sourcecountry: string;
}

function buildQuery(opts: { keywords: string[]; lat: number; lng: number; radiusKm: number }) {
  const phrases = opts.keywords.map((k) => (k.includes(' ') ? `"${k}"` : k)).join(' OR ');
  // GDELT's near operator: near:"<distanceKm>km,<lat>,<lng>".
  // We OR the keyword block with the geo filter so the geo filter is the gate.
  const geo = `near:"${Math.round(opts.radiusKm)}km,${opts.lat.toFixed(4)},${opts.lng.toFixed(4)}"`;
  return `(${phrases}) ${geo}`;
}

export async function POST(req: NextRequest) {
  const { caseId, lat, lng, radiusKm, keywords, timespan } = await req.json();
  if (lat == null || lng == null) {
    return NextResponse.json({ error: 'lat and lng required' }, { status: 400 });
  }

  const radius = Number(radiusKm) || Number(process.env.INTEL_GDELT_RADIUS_KM) || 80;
  const kw = Array.isArray(keywords) && keywords.length ? keywords : DEFAULT_KEYWORDS;
  const span = timespan || '24h';

  const db = getSupa();
  if (caseId) {
    await emit(db, caseId, 'intel.gdelt', 'start', {
      status: 'querying_global_events',
      radius_km: radius,
      timespan: span,
    });
  }

  const url =
    `${GDELT_BASE}?` +
    new URLSearchParams({
      query: buildQuery({ keywords: kw, lat: Number(lat), lng: Number(lng), radiusKm: radius }),
      mode: 'ArtList',
      format: 'json',
      maxrecords: '25',
      timespan: span,
      sort: 'DateDesc',
    }).toString();

  let articles: GdeltArticle[] = [];
  let error: string | null = null;

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { 'User-Agent': 'Argus def/acc (https://github.com/argus)' },
    });
    if (response.ok) {
      const text = await response.text();
      try {
        const data = text ? JSON.parse(text) : { articles: [] };
        articles = (data.articles || []) as GdeltArticle[];
      } catch {
        error = 'gdelt returned non-json';
      }
    } else {
      error = `gdelt ${response.status}`;
    }
  } catch (err: any) {
    error = err?.message || 'gdelt network error';
  }

  const top = articles.slice(0, 8).map((a) => ({
    url: a.url,
    title: a.title,
    domain: a.domain,
    seendate: a.seendate,
    language: a.language,
    socialimage: a.socialimage,
  }));

  if (caseId) {
    await emit(db, caseId, 'intel.gdelt', error ? 'error' : 'complete', {
      status: error ? 'gdelt_failed' : 'context_enriched',
      count: top.length,
      radius_km: radius,
      lat,
      lng,
      articles: top,
      error,
    });
  }

  return NextResponse.json({
    ok: !error,
    count: top.length,
    radius_km: radius,
    articles: top,
    error,
  });
}
