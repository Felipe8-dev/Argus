import { NextRequest } from 'next/server';

export const runtime = 'nodejs';

/**
 * Same-origin passthrough for remote media (image or video).
 *
 * face-api reads pixels off a <canvas>; a cross-origin <img>/<video> taints
 * the canvas and blocks `getImageData`. Routing the social-post media through
 * this proxy makes it same-origin, so the scanner can read frames freely.
 *
 * Forwards Range requests so the browser can stream/seek video.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const target = req.nextUrl.searchParams.get('url');
  if (!target) return new Response('url missing', { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return new Response('invalid protocol', { status: 400 });
    }
  } catch {
    return new Response('invalid url', { status: 400 });
  }

  const range = req.headers.get('range');
  const upstream = await fetch(parsed.toString(), {
    headers: {
      ...(range ? { Range: range } : {}),
      // Some CDNs need a UA + referer to serve media.
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    },
    cache: 'no-store',
  }).catch(() => null);

  if (!upstream || !upstream.ok && upstream.status !== 206) {
    return new Response('cannot fetch media', { status: upstream?.status || 502 });
  }

  const headers = new Headers();
  const ct = upstream.headers.get('content-type') || 'application/octet-stream';
  headers.set('Content-Type', ct);
  headers.set('Cache-Control', 'public, max-age=3600');
  headers.set('Accept-Ranges', 'bytes');
  for (const h of ['content-length', 'content-range']) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}
