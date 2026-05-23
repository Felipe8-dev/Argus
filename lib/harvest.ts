// Harvest layer — read public comments/replies from an operator-controlled
// post URL and score each one for sighting intent.
//
// def/acc rationale: instead of scraping behind login walls (fragile,
// adversarial), we publish the alert to a page WE control and then
// listen for tips in the comments. The operator hands the post URL to
// Argus and we use the existing page access token (already required by
// /api/publish) to read comments via Graph API.

import { SIGHTING_REGEX_TAGS } from './social-osint-shared';

export type HarvestPlatform = 'facebook' | 'instagram' | 'twitter' | 'unknown';

export interface HarvestedComment {
  platform: HarvestPlatform;
  source_url: string;
  comment_id: string;
  author_name: string;
  author_id?: string;
  text: string;
  created_at?: string;
  score: number;
  matched: string[];
}

export interface HarvestResult {
  ok: boolean;
  platform: HarvestPlatform;
  postUrl: string;
  post_id?: string;
  total: number;
  scored: HarvestedComment[]; // only score > 0
  error?: string;
  hint?: string;
}

export function detectPlatform(url: string): HarvestPlatform {
  try {
    const u = new URL(url);
    if (/facebook\.com$/.test(u.hostname) || /\.facebook\.com$/.test(u.hostname)) return 'facebook';
    if (/instagram\.com$/.test(u.hostname) || /\.instagram\.com$/.test(u.hostname)) return 'instagram';
    if (/(x|twitter)\.com$/.test(u.hostname) || /\.(x|twitter)\.com$/.test(u.hostname)) return 'twitter';
  } catch {}
  return 'unknown';
}

/**
 * Extracts the numeric post id from common Facebook post URL shapes:
 *   facebook.com/<page>/posts/<id>
 *   facebook.com/permalink.php?story_fbid=<id>&id=<page>
 *   facebook.com/<page>/posts/pfbid0XXXX  (newer encrypted ids)
 * For encrypted pfbid0… we return the raw token; Graph API accepts it.
 */
export function extractFacebookPostId(url: string, fallbackPageId?: string): string | null {
  try {
    const u = new URL(url);

    const m1 = u.pathname.match(/\/posts\/(?:pfbid[0-9a-zA-Z]+|\d+)/);
    if (m1) {
      const idMatch = m1[0].match(/\/posts\/(.+)/);
      const id = idMatch?.[1];
      if (!id) return null;
      // Graph wants `<pageid>_<postid>` for legacy numeric ids.
      if (/^\d+$/.test(id) && fallbackPageId) return `${fallbackPageId}_${id}`;
      return id;
    }
    const storyFbid = u.searchParams.get('story_fbid');
    const ownerId = u.searchParams.get('id');
    if (storyFbid && ownerId) return `${ownerId}_${storyFbid}`;

    // /<page>/photos/<id> style — not strictly a post but Graph treats it as one.
    const m2 = u.pathname.match(/\/photos\/[^/]*\/(\d+)/);
    if (m2 && fallbackPageId) return `${fallbackPageId}_${m2[1]}`;
  } catch {}
  return null;
}

/** Tries Facebook Graph API to list comments under a post. */
async function harvestFacebook(postUrl: string): Promise<HarvestResult> {
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  if (!token) {
    return {
      ok: false,
      platform: 'facebook',
      postUrl,
      total: 0,
      scored: [],
      error: 'FACEBOOK_PAGE_ACCESS_TOKEN missing',
      hint: 'Set FACEBOOK_PAGE_ACCESS_TOKEN so harvest can read comments via Graph API.',
    };
  }

  const postId = extractFacebookPostId(postUrl, pageId || undefined);
  if (!postId) {
    return {
      ok: false,
      platform: 'facebook',
      postUrl,
      total: 0,
      scored: [],
      error: 'cannot_extract_post_id',
      hint: 'Pass a URL like facebook.com/<page>/posts/<id> or facebook.com/permalink.php?story_fbid=…&id=…',
    };
  }

  const version = process.env.FACEBOOK_GRAPH_VERSION || 'v20.0';
  const url =
    `https://graph.facebook.com/${version}/${encodeURIComponent(postId)}/comments` +
    `?fields=id,message,from{id,name},created_time,comment_count,like_count` +
    `&limit=100&access_token=${encodeURIComponent(token)}`;

  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch (err: any) {
    return {
      ok: false,
      platform: 'facebook',
      postUrl,
      post_id: postId,
      total: 0,
      scored: [],
      error: err?.message || 'network',
    };
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      platform: 'facebook',
      postUrl,
      post_id: postId,
      total: 0,
      scored: [],
      error: data?.error?.message || `graph ${response.status}`,
    };
  }
  const rows: any[] = data?.data || [];
  const scored: HarvestedComment[] = [];
  for (const row of rows) {
    const text = String(row.message || '').trim();
    if (!text) continue;
    const { score, matched } = scoreText(text);
    if (score <= 0) continue;
    scored.push({
      platform: 'facebook',
      source_url: `https://facebook.com/${row.id}`,
      comment_id: String(row.id),
      author_name: row.from?.name || 'Anónimo',
      author_id: row.from?.id,
      text: text.slice(0, 1200),
      created_at: row.created_time,
      score,
      matched,
    });
  }
  return {
    ok: true,
    platform: 'facebook',
    postUrl,
    post_id: postId,
    total: rows.length,
    scored,
  };
}

/** Instagram via Graph API. Requires the post id as an IG media id. */
async function harvestInstagram(postUrl: string): Promise<HarvestResult> {
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!token) {
    return {
      ok: false, platform: 'instagram', postUrl, total: 0, scored: [],
      error: 'FACEBOOK_PAGE_ACCESS_TOKEN missing (IG comments are read via FB business graph)',
    };
  }
  // We need the IG media id. The URL alone (instagram.com/p/<shortcode>) is
  // not directly queryable without the linked IG business account workflow.
  return {
    ok: false,
    platform: 'instagram',
    postUrl,
    total: 0,
    scored: [],
    error: 'instagram_harvest_requires_business_account',
    hint: 'Link your IG to the FB page and pass the IG media id instead of the URL.',
  };
}

/** Twitter / X via Nitter — best-effort, no key. */
async function harvestTwitter(postUrl: string): Promise<HarvestResult> {
  const host = process.env.NITTER_HOST || 'https://nitter.net';
  let path: string;
  try {
    const u = new URL(postUrl);
    path = u.pathname; // /<user>/status/<id>
  } catch {
    return {
      ok: false, platform: 'twitter', postUrl, total: 0, scored: [],
      error: 'invalid_url',
    };
  }
  let response: Response;
  try {
    response = await fetch(`${host}${path}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64; Argus def/acc) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      },
      cache: 'no-store',
    });
  } catch (err: any) {
    return {
      ok: false, platform: 'twitter', postUrl, total: 0, scored: [],
      error: err?.message || 'network',
      hint: 'Set NITTER_HOST to a working nitter instance.',
    };
  }
  if (!response.ok) {
    return {
      ok: false, platform: 'twitter', postUrl, total: 0, scored: [],
      error: `nitter ${response.status}`,
    };
  }
  const html = await response.text();
  // Very small parser: nitter renders replies as <div class="tweet-content media-body">
  // Extract all instances; skip the first one (= the original tweet).
  const re = /<div class="tweet-content media-body"[^>]*>([\s\S]*?)<\/div>/g;
  const all: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = stripHtml(m[1]);
    if (text) all.push(text);
  }
  const replies = all.slice(1); // first is the OP tweet

  const scored: HarvestedComment[] = [];
  for (const text of replies) {
    const { score, matched } = scoreText(text);
    if (score <= 0) continue;
    scored.push({
      platform: 'twitter',
      source_url: postUrl,
      comment_id: `nitter-${scored.length}`,
      author_name: 'Reply',
      text: text.slice(0, 1200),
      score,
      matched,
    });
  }
  return {
    ok: true,
    platform: 'twitter',
    postUrl,
    total: replies.length,
    scored,
  };
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

/** Re-export of the sighting scorer (kept in shared module for reuse). */
function scoreText(text: string) {
  let best = 0;
  const matched: string[] = [];
  for (const { pattern, weight, tag } of SIGHTING_REGEX_TAGS) {
    if (pattern.test(text)) {
      matched.push(tag);
      if (weight > best) best = weight;
    }
  }
  return { score: best, matched };
}

export async function harvestPost(postUrl: string): Promise<HarvestResult> {
  const platform = detectPlatform(postUrl);
  switch (platform) {
    case 'facebook': return harvestFacebook(postUrl);
    case 'instagram': return harvestInstagram(postUrl);
    case 'twitter': return harvestTwitter(postUrl);
    default:
      return {
        ok: false, platform, postUrl, total: 0, scored: [],
        error: 'unknown_platform',
        hint: 'Pass a public facebook/instagram/x.com URL.',
      };
  }
}
