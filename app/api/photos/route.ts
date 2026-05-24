import { NextResponse } from 'next/server';
import { PHOTOS } from '@/data/photos';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

/**
 * Photo candidate feed for Ghost vision search.
 *
 * Demo modes:
 *   - normal:           returns the seeded PHOTOS dataset + the target (if any)
 *   - FOCUS_TARGET_ONLY=true: returns ONLY the FACEBOOK_TARGET_* photo.
 *     Use this for a focused, low-cost demo where Ghost compares the
 *     family portrait against one specific public photo and lands on
 *     it as the coincidence.
 */
export async function GET(req: Request) {
  const base = new URL(req.url).origin;

  // Allow a relative path (e.g. /demo/match.jpg served from public/) so the
  // controlled-test target doesn't depend on the deployment URL.
  const rawTargetImg = process.env.FACEBOOK_TARGET_IMAGE_URL;
  const targetImgUrl = rawTargetImg
    ? rawTargetImg.startsWith('/')
      ? `${base}${rawTargetImg}`
      : rawTargetImg
    : null;

  const target =
    targetImgUrl
      ? {
          url: targetImgUrl,
          source_site: 'facebook-target',
          source_page:
            process.env.FACEBOOK_TARGET_POST_URL ||
            process.env.FACEBOOK_TARGET_PROFILE_URL ||
            targetImgUrl,
          posted_by: process.env.FACEBOOK_TARGET_NAME || 'facebook-target',
          posted_at: new Date().toISOString(),
          gps_lat: Number(process.env.FACEBOOK_TARGET_GPS_LAT || 10.4236),
          gps_lon: Number(process.env.FACEBOOK_TARGET_GPS_LON || -75.5508),
          place_label: process.env.FACEBOOK_TARGET_PLACE || 'Cartagena',
        }
      : null;

  if (process.env.FOCUS_TARGET_ONLY === 'true') {
    return NextResponse.json(target ? [target] : [], {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const out: any[] = PHOTOS
    .filter((p) => {
      if (p.url) return true;
      if (!p.filename) return false;
      return fs.existsSync(path.join(process.cwd(), 'public', 'photos', p.filename));
    })
    .map((p) => ({
      url: p.url || `${base}/photos/${p.filename}`,
      source_site: p.source_site,
      source_page: `${base}/perfil/${p.username}`,
      posted_by: p.username,
      posted_at: p.postedAt,
      gps_lat: p.gps_lat ?? p.exif?.lat,
      gps_lon: p.gps_lon ?? p.exif?.lon,
      place_label: p.place_label,
    }));

  if (target) out.unshift(target);

  return NextResponse.json(out, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
