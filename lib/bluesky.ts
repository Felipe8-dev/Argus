/**
 * Bluesky Jetstream — public AT-Proto firehose.
 *
 * Endpoint público sin auth: wss://jetstream2.us-east.bsky.network/subscribe
 * Docs: https://docs.bsky.app/blog/jetstream
 *
 * Usamos esto como "señal social en vivo" — un ticker que muestra
 * posts mencionando el nombre del desaparecido o la zona, en tiempo
 * real, mientras corre la operación. Visualmente brutal para el demo
 * de def/acc.
 */

export const JETSTREAM_ENDPOINT =
  process.env.BLUESKY_JETSTREAM_URL ||
  'wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post';

export const SEARCH_API = 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts';

export interface BlueskyFilters {
  subjectName?: string | null;
  zone?: string | null;
  /** keywords adicionales (lowercase) que dispararán match si aparecen en text */
  extraKeywords?: string[];
}

const DEFAULT_KEYWORDS = [
  'desaparecid',
  'desaparecida',
  'desaparecido',
  'perdid',
  'buscando',
  'alguien lo ha visto',
  'alguien la ha visto',
  'amber',
];

/**
 * Pure function: ¿este texto matchea con los filtros del caso?
 * Devuelve el motivo de match para debug y UI.
 */
export function matchPost(
  text: string,
  filters: BlueskyFilters,
): { match: boolean; reason?: string } {
  if (!text) return { match: false };
  const lower = text.toLowerCase();

  if (filters.subjectName) {
    const name = filters.subjectName.toLowerCase().trim();
    if (name.length >= 3 && lower.includes(name)) {
      return { match: true, reason: `nombre: ${filters.subjectName}` };
    }
  }

  if (filters.zone) {
    const zone = filters.zone.toLowerCase().trim();
    const firstZoneToken = zone.split(/[,\s]/)[0];
    if (firstZoneToken && firstZoneToken.length >= 4 && lower.includes(firstZoneToken)) {
      return { match: true, reason: `zona: ${firstZoneToken}` };
    }
  }

  const all = [...DEFAULT_KEYWORDS, ...(filters.extraKeywords || []).map((k) => k.toLowerCase())];
  for (const kw of all) {
    if (lower.includes(kw)) {
      return { match: true, reason: `palabra: ${kw}` };
    }
  }

  return { match: false };
}

export interface BlueskyPost {
  at: string;
  did: string;
  handle?: string;
  text: string;
  uri: string;
  lang?: string;
  reason?: string;
  source: 'live' | 'historical';
}

export function buildBlueskyUrl(did: string, uri: string): string {
  // uri format: at://did/app.bsky.feed.post/rkey
  const rkey = uri.split('/').pop();
  if (!rkey) return `https://bsky.app/profile/${did}`;
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

/** Fallback histórico vía REST searchPosts cuando no hay tráfico vivo. */
export async function fetchHistoricalPosts(query: string, limit = 5): Promise<BlueskyPost[]> {
  try {
    const url = `${SEARCH_API}?q=${encodeURIComponent(query)}&limit=${limit}&lang=es`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const json: any = await res.json();
    const posts = (json?.posts || []) as any[];
    return posts.map((p) => ({
      at: p.indexedAt || p.record?.createdAt || new Date().toISOString(),
      did: p.author?.did || '',
      handle: p.author?.handle,
      text: (p.record?.text || '').slice(0, 280),
      uri: p.uri || '',
      lang: (p.record?.langs || [])[0],
      reason: `histórico: ${query}`,
      source: 'historical' as const,
    }));
  } catch (err: any) {
    console.error('[bluesky] historical fetch failed:', err?.message);
    return [];
  }
}
