import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyManifest, type SignedManifest } from '@/lib/c2pa';

export const runtime = 'nodejs';

function getSupa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * GET /api/c2pa/verify?case=<id>
 * Re-descarga portrait + sidecar y verifica firma.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const caseId = url.searchParams.get('case');
  const directImage = url.searchParams.get('image');
  const directManifest = url.searchParams.get('manifest');

  if (directImage && directManifest) {
    const [imgRes, mfRes] = await Promise.all([fetch(directImage), fetch(directManifest)]);
    if (!imgRes.ok || !mfRes.ok) {
      return NextResponse.json({ ok: false, error: 'fetch failed' }, { status: 400 });
    }
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const manifest = (await mfRes.json()) as SignedManifest;
    const verdict = verifyManifest(buf, manifest);
    return NextResponse.json({ ok: verdict.valid, verdict, manifest });
  }

  if (!caseId) return NextResponse.json({ ok: false, error: 'caseId required' }, { status: 400 });

  const db = getSupa();
  if (!db) return NextResponse.json({ ok: false, error: 'supabase_unconfigured' }, { status: 500 });

  const { data: kase } = await db.from('cases').select('id, portrait_url, description').eq('id', caseId).single();
  if (!kase?.portrait_url) return NextResponse.json({ ok: false, error: 'no portrait' }, { status: 404 });

  const manifestUrl = `${kase.portrait_url}.cr.json`;
  const [imgRes, mfRes] = await Promise.all([fetch(kase.portrait_url), fetch(manifestUrl)]);
  if (!mfRes.ok) {
    return NextResponse.json({ ok: false, error: 'no manifest sidecar' }, { status: 404 });
  }
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const manifest = (await mfRes.json()) as SignedManifest;
  const verdict = verifyManifest(buf, manifest);

  return NextResponse.json({
    ok: verdict.valid,
    verdict,
    manifest,
    portrait_url: kase.portrait_url,
    manifest_url: manifestUrl,
  });
}
