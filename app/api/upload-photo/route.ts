import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { signImage, sha256 } from '@/lib/c2pa';

function getSupa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function POST(req: NextRequest) {
  const db = getSupa();
  if (!db) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const formData = await req.formData();
  const file = formData.get('photo') as File | null;
  if (!file) return NextResponse.json({ error: 'No photo' }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  // Supabase Storage keys reject spaces, accents and most non-ASCII chars.
  // WhatsApp/iPhone exports almost always trip this, so we normalize the
  // filename to a safe slug and keep the extension only.
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
  const path = `case-media/web-${Date.now()}.${ext}`;
  const caseId = formData.get('caseId')?.toString();

  const { error } = await db.storage.from('portraits').upload(path, buf, {
    contentType: file.type || 'image/jpeg',
    upsert: true,
  });

  if (error) {
    console.error('[upload-photo] supabase error:', error);
    return NextResponse.json({ error: error.message || 'storage_upload_failed' }, { status: 500 });
  }

  const { data } = db.storage.from('portraits').getPublicUrl(path);
  console.log('[upload-photo] saved:', data.publicUrl);

  // ---- C2PA-inspired sidecar manifest --------------------------------------
  // Firmamos un manifiesto JSON con ed25519 y lo subimos junto al portrait
  // para que cualquiera pueda verificar integridad y autoría defensiva.
  let provenanceManifestUrl: string | null = null;
  let portraitSha256: string | null = null;
  try {
    const { manifest } = await signImage(buf, {
      caseId: caseId || null,
      publishedBy: 'argus-defacc',
      purpose: 'portrait_intake',
      source: 'family_upload',
    });
    portraitSha256 = manifest.sha256;
    const sidecarPath = `${path}.cr.json`;
    const sidecarBuf = Buffer.from(JSON.stringify(manifest, null, 2));
    const { error: sidecarErr } = await db.storage.from('portraits').upload(sidecarPath, sidecarBuf, {
      contentType: 'application/json',
      upsert: true,
    });
    if (!sidecarErr) {
      const { data: side } = db.storage.from('portraits').getPublicUrl(sidecarPath);
      provenanceManifestUrl = side.publicUrl;
      console.log('[upload-photo] manifest sidecar:', provenanceManifestUrl);
    } else {
      console.warn('[upload-photo] sidecar upload failed:', sidecarErr.message);
    }
  } catch (err: any) {
    // C2PA es enhancement — si falla seguimos sin badge.
    console.warn('[upload-photo] c2pa sign failed:', err?.message);
    portraitSha256 = sha256(buf);
  }

  // Persistir hash + manifest URL en el caso si está disponible.
  if (caseId) {
    db.from('cases').update({
      portrait_sha256: portraitSha256,
      provenance_manifest_url: provenanceManifestUrl,
    }).eq('id', caseId).then(() => {}, (err) => console.warn('[upload-photo] persist meta:', err?.message));
  }

  // Fire provenance check in the background. The badge surfaces in the live
  // dashboard via the intel.provenance pipeline event. caseId is optional
  // here because the photo can arrive before the case row exists.
  const origin = req.nextUrl.origin;
  fetch(`${origin}/api/intel/provenance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caseId, photoUrl: data.publicUrl }),
  }).catch((err) => console.error('[upload-photo] provenance dispatch:', err?.message));

  return NextResponse.json({
    url: data.publicUrl,
    manifest_url: provenanceManifestUrl,
    sha256: portraitSha256,
  });
}
