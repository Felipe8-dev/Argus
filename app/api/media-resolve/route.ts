import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Resolve a URL into a directly-loadable media file for the scanner.
 *
 * The operator pastes a *post* link (a random social account that published
 * the photo/video with the missing person in the background). That page isn't
 * a media file, so we fetch it and extract the og:video / og:image the
 * platform exposes. If the URL is already a direct image/video, we pass it
 * through untouched.
 *
 * Returns: { ok, type: 'image' | 'video' | 'unknown', mediaUrl, proxied }
 *   proxied = /api/media-proxy?url=<mediaUrl>  (same-origin, canvas-safe)
 */
function proxied(url: string) {
  return `/api/media-proxy?url=${encodeURIComponent(url)}`;
}

function pickMeta(html: string, props: string[]): string | null {
  for (const prop of props) {
    // <meta property="og:video" content="..."> (attr order varies)
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`,
      'i',
    );
    const m = html.match(re);
    if (m?.[1]) return m[1];
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`,
      'i',
    );
    const m2 = html.match(re2);
    if (m2?.[1]) return m2[1];
  }
  return null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const target = req.nextUrl.searchParams.get('url');
  if (!target) return NextResponse.json({ ok: false, error: 'url missing' }, { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('proto');
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid url' }, { status: 400 });
  }

  // Fast path: extension says it's already a media file.
  const path = parsed.pathname.toLowerCase();
  if (/\.(mp4|webm|mov|m4v)$/.test(path)) {
    return NextResponse.json({ ok: true, type: 'video', mediaUrl: target, proxied: proxied(target) });
  }
  if (/\.(jpg|jpeg|png|webp|gif|avif)$/.test(path)) {
    return NextResponse.json({ ok: true, type: 'image', mediaUrl: target, proxied: proxied(target) });
  }

  // Otherwise fetch and inspect: direct media by content-type, or parse og: tags.
  const res = await fetch(parsed.toString(), {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    },
    cache: 'no-store',
  }).catch(() => null);

  if (!res || !res.ok) {
    return NextResponse.json({ ok: false, error: `fetch ${res?.status || 'failed'}` }, { status: 502 });
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.startsWith('image/')) {
    return NextResponse.json({ ok: true, type: 'image', mediaUrl: target, proxied: proxied(target) });
  }
  if (ct.startsWith('video/')) {
    return NextResponse.json({ ok: true, type: 'video', mediaUrl: target, proxied: proxied(target) });
  }

  const html = await res.text().catch(() => '');
  const video = pickMeta(html, ['og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream']);
  if (video) {
    const abs = new URL(video, parsed).toString();
    return NextResponse.json({ ok: true, type: 'video', mediaUrl: abs, proxied: proxied(abs) });
  }
  const image = pickMeta(html, ['og:image:secure_url', 'og:image', 'twitter:image']);
  if (image) {
    const abs = new URL(image, parsed).toString();
    return NextResponse.json({ ok: true, type: 'image', mediaUrl: abs, proxied: proxied(abs) });
  }

  return NextResponse.json({ ok: false, type: 'unknown', error: 'no_media_found' });
}
