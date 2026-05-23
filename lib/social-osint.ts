// Social OSINT for missing-person search — defensive repurposing of the
// `auto-social` lead-scraping engine (~/Descargas/outliers/auto-social).
//
// Original use: Google `site:` operators to find purchase-intent posts.
// Defensive twist: same primitive used to find PUBLIC SIGHTINGS of a
// reported missing person across Facebook / Instagram / X — without
// logging in, without scraping behind walls, only public indexed posts.
//
// Pipeline (per platform, run in parallel):
//   1. compose query = person name + sighting verb + last-seen city
//   2. hit DuckDuckGo HTML SERP (no key, no JS render needed)
//   3. filter results to the target platform domain
//   4. score each snippet with the same regex+AI dual approach
//   5. return SightingCandidate[] for the orchestrator to act on
//
// We deliberately stay HTTP-only (no Playwright) so this runs inside the
// Next.js serverless runtime without extra binaries.

export type SocialPlatform = 'facebook' | 'instagram' | 'twitter';

export interface SightingCandidate {
  platform: SocialPlatform;
  url: string;
  title: string;
  snippet: string;
  score: number; // 0..1 regex confidence
  matchedKeywords: string[];
}

const PLATFORM_DOMAINS: Record<SocialPlatform, string[]> = {
  facebook: ['facebook.com'],
  instagram: ['instagram.com'],
  twitter: ['x.com', 'twitter.com'],
};

const PLATFORM_QUERY_SITE: Record<SocialPlatform, string> = {
  facebook: 'site:facebook.com',
  instagram: 'site:instagram.com',
  twitter: 'site:x.com OR site:twitter.com',
};

import { SIGHTING_REGEX_TAGS as SIGHTING_PATTERNS } from './social-osint-shared';

interface SightingQuery {
  personName: string;
  city?: string;
  ropa?: string;
  edad?: number | string;
  extraTerms?: string[];
}

/** Compose the SERP query for a given platform + case description. */
function buildQuery(platform: SocialPlatform, q: SightingQuery): string {
  const parts: string[] = [PLATFORM_QUERY_SITE[platform]];
  if (q.personName) parts.push(`"${q.personName}"`);

  // ANY of these terms boosts recall. Joined with OR so the SERP matches
  // posts that contain at least one signal.
  const signals = [
    'desaparecido',
    'desaparecida',
    'visto',
    'vista',
    'ayuden',
    'ayuda',
    'encontrar',
    'encontrada',
    'extraviado',
    'extraviada',
    'missing',
    'seen',
  ];
  parts.push(`(${signals.map((s) => `"${s}"`).join(' OR ')})`);

  if (q.city) parts.push(`"${q.city}"`);
  if (q.extraTerms?.length) parts.push(...q.extraTerms.map((t) => `"${t}"`));

  return parts.join(' ');
}

/** Strip DDG's redirect wrapper from result links: /l/?uddg=... → real URL. */
function unwrapDdgUrl(href: string): string {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return href;
  } catch {
    return href;
  }
}

/** Very small HTML extractor for DDG SERP rows. No DOM, just regex. */
function parseDdgSerp(html: string): Array<{ url: string; title: string; snippet: string }> {
  const items: Array<{ url: string; title: string; snippet: string }> = [];
  // Match the table rows DDG uses: <a class="result__a" href="...">title</a> then a snippet <a class="result__snippet">…</a>
  const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,400}?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const [, hrefRaw, titleRaw, snippetRaw] = m;
    items.push({
      url: unwrapDdgUrl(hrefRaw),
      title: stripHtml(titleRaw),
      snippet: stripHtml(snippetRaw),
    });
  }
  return items;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreSnippet(snippet: string): { score: number; matched: string[] } {
  let best = 0;
  const matched: string[] = [];
  for (const { pattern, weight, tag } of SIGHTING_PATTERNS) {
    if (pattern.test(snippet)) {
      matched.push(tag);
      if (weight > best) best = weight;
    }
  }
  return { score: best, matched };
}

function isPlatformUrl(platform: SocialPlatform, url: string): boolean {
  try {
    const u = new URL(url);
    return PLATFORM_DOMAINS[platform].some((d) => u.hostname.endsWith(d));
  } catch {
    return false;
  }
}

const DDG_HTML = 'https://html.duckduckgo.com/html/';
const BRAVE_API = 'https://api.search.brave.com/res/v1/web/search';
const SERPER_API = 'https://google.serper.dev/search';

// --- Rate limiter (per source) ----------------------------------------
// Tuneable via env so the operator can crank it up when running long
// sweeps. Defaults are intentionally generous for the demo (1 req/sec)
// but capped per source to avoid hard-banning the upstream.
const RATE_RPS = Math.max(0.2, Number(process.env.OSINT_RATE_RPS) || 1);
const lastHit: Record<string, number> = {};

async function throttle(source: string): Promise<void> {
  const gapMs = Math.round(1000 / RATE_RPS);
  const now = Date.now();
  const since = now - (lastHit[source] || 0);
  if (since < gapMs) {
    await new Promise((r) => setTimeout(r, gapMs - since));
  }
  lastHit[source] = Date.now();
}

export type OsintSource = 'brave' | 'serper' | 'duckduckgo' | 'none';

interface RawRow { url: string; title: string; snippet: string }

async function searchBrave(query: string): Promise<RawRow[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return [];
  await throttle('brave');
  const url = `${BRAVE_API}?${new URLSearchParams({ q: query, count: '20' }).toString()}`;
  const res = await fetch(url, {
    headers: {
      'X-Subscription-Token': key,
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
    },
    cache: 'no-store',
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const data: any = await res.json().catch(() => null);
  const items: any[] = data?.web?.results || [];
  return items.map((it) => ({
    url: it.url || '',
    title: stripHtml(it.title || ''),
    snippet: stripHtml(it.description || it.snippet || ''),
  }));
}

async function searchSerper(query: string): Promise<RawRow[]> {
  const key = process.env.SERPER_API_KEY;
  if (!key) return [];
  await throttle('serper');
  const res = await fetch(SERPER_API, {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: 20, gl: 'co', hl: 'es' }),
    cache: 'no-store',
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const data: any = await res.json().catch(() => null);
  const items: any[] = data?.organic || [];
  return items.map((it) => ({
    url: it.link || '',
    title: stripHtml(it.title || ''),
    snippet: stripHtml(it.snippet || ''),
  }));
}

async function searchDuckDuckGo(query: string): Promise<RawRow[]> {
  await throttle('ddg');
  const body = new URLSearchParams({ q: query });
  let response: Response;
  try {
    response = await fetch(DDG_HTML, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64; Argus def/acc) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      },
      body,
      cache: 'no-store',
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  const html = await response.text();
  // DDG sometimes throws an anomaly challenge; return [] silently then.
  if (html.includes('anomaly-modal')) return [];
  return parseDdgSerp(html);
}

export interface SourceMeta { source: OsintSource; usedKey: boolean }

async function searchPlatform(
  platform: SocialPlatform,
  q: SightingQuery,
  meta: { source: OsintSource } = { source: 'none' },
): Promise<SightingCandidate[]> {
  const query = buildQuery(platform, q);

  // Try paid/reliable APIs first; fall back to DDG.
  let rows: RawRow[] = [];
  if (process.env.BRAVE_SEARCH_API_KEY) {
    rows = await searchBrave(query);
    if (rows.length) meta.source = 'brave';
  }
  if (!rows.length && process.env.SERPER_API_KEY) {
    rows = await searchSerper(query);
    if (rows.length) meta.source = 'serper';
  }
  if (!rows.length) {
    rows = await searchDuckDuckGo(query);
    if (rows.length) meta.source = 'duckduckgo';
  }

  const filtered = rows.filter((r) => isPlatformUrl(platform, r.url));
  const seen = new Set<string>();
  const candidates: SightingCandidate[] = [];
  for (const row of filtered) {
    if (seen.has(row.url)) continue;
    seen.add(row.url);
    const text = `${row.title} ${row.snippet}`;
    const { score, matched } = scoreSnippet(text);
    candidates.push({
      platform,
      url: row.url,
      title: row.title,
      snippet: row.snippet,
      score,
      matchedKeywords: matched,
    });
  }
  return candidates;
}

/** Public entrypoint — run all 3 platforms in parallel, keep top-N. */
export async function findPublicSightings(
  q: SightingQuery,
  opts: { perPlatform?: number; minScore?: number } = {},
): Promise<{ candidates: SightingCandidate[]; source: OsintSource }> {
  if (!q.personName?.trim()) return { candidates: [], source: 'none' };
  const perPlatform = opts.perPlatform ?? 6;
  const minScore = opts.minScore ?? 0.35;

  const meta: { source: OsintSource } = { source: 'none' };
  const results = await Promise.all(
    (['facebook', 'instagram', 'twitter'] as SocialPlatform[]).map((p) =>
      searchPlatform(p, q, meta),
    ),
  );

  const candidates = results
    .flat()
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, perPlatform * 3);

  return { candidates, source: meta.source };
}
