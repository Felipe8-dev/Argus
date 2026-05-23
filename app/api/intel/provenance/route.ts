import { NextRequest, NextResponse } from 'next/server';
import { emit, getSupa } from '@/lib/argus-server';
import { inspectPhoto } from '@/lib/provenance';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/intel/provenance
 *
 * Body: { caseId?, photoUrl }
 *
 * Inspects the photo for EXIF, computes a perceptual hash, and asks
 * Gemini Vision whether the image is AI-generated. Emits a pipeline
 * event "intel.provenance" so the UI can render a badge:
 *
 *   VERIFIED → score >= 0.65 (camera EXIF, looks real)
 *   SUSPECT  → score <= 0.35 (no EXIF + AI-leaning)
 *   UNKNOWN  → in between
 *
 * Soft-fails: if the upstream image can't be downloaded we return a
 * structured unknown verdict so the pipeline isn't blocked.
 */
export async function POST(req: NextRequest) {
  const { caseId, photoUrl } = await req.json();
  if (!photoUrl) {
    return NextResponse.json({ error: 'photoUrl required' }, { status: 400 });
  }

  const db = getSupa();
  if (caseId) {
    await emit(db, caseId, 'intel.provenance', 'start', {
      status: 'inspecting_photo',
      photoUrl,
    });
  }

  try {
    const report = await inspectPhoto(photoUrl);
    if (caseId) {
      await emit(db, caseId, 'intel.provenance', 'complete', {
        status: `verdict_${report.verdict}`,
        photoUrl,
        verdict: report.verdict,
        score: report.score,
        has_exif: report.signals.hasExif,
        ai_verdict: report.signals.ai.checked ? report.signals.ai.verdict : null,
        ai_confidence: report.signals.ai.checked ? report.signals.ai.confidence : null,
        perceptual_hash: report.signals.perceptualHash,
      });
    }
    return NextResponse.json({ ok: true, ...report });
  } catch (err: any) {
    if (caseId) {
      await emit(db, caseId, 'intel.provenance', 'error', {
        status: 'inspection_failed',
        error: err?.message || 'unknown',
      });
    }
    return NextResponse.json({
      ok: false,
      verdict: 'unknown',
      score: 0.5,
      error: err?.message || 'unknown',
    }, { status: 200 });
  }
}
