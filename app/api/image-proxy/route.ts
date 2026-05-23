import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url');
  if (!url) return NextResponse.json({ error: 'url missing' }, { status: 400 });

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return NextResponse.json({ error: 'invalid protocol' }, { status: 400 });
    }

    const response = await fetch(parsed.toString());
    if (!response.ok) {
      return NextResponse.json({ error: 'cannot fetch image' }, { status: response.status });
    }

    const input = Buffer.from(await response.arrayBuffer());
    const png = await sharp(input).rotate().resize(900, 900, { fit: 'cover' }).png().toBuffer();

    return new Response(new Uint8Array(png), {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'image proxy failed' }, { status: 500 });
  }
}
