import { NextResponse } from 'next/server';

interface TileParams {
  params: {
    z: string;
    x: string;
    y: string;
  };
}

export const runtime = 'nodejs';

export async function GET(_: Request, { params }: TileParams) {
  const token = process.env.MAPBOX_TOKEN;
  const canUseMapboxTiles = Boolean(token?.startsWith('pk.'));
  const { z, x, y } = params;

  const mapboxUrl = canUseMapboxTiles
    ? `https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/256/${z}/${x}/${y}?access_token=${token}`
    : null;
  const fallbackUrl = `https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`;

  // `next.revalidate` is a Next.js extension that isn't in the standard RequestInit types — cast.
  const nextOpts = { next: { revalidate: 60 * 60 * 24 } } as RequestInit;
  const mapboxResponse = mapboxUrl ? await fetch(mapboxUrl, nextOpts) : null;
  const response = mapboxResponse?.ok ? mapboxResponse : await fetch(fallbackUrl, nextOpts);

  if (!response.ok || !response.body) {
    return NextResponse.json({ error: 'Tile unavailable' }, { status: response.status || 502 });
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      'content-type': response.headers.get('content-type') || 'image/png',
      'cache-control': 'public, max-age=86400',
    },
  });
}
