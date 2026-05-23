import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { anchorCase, type CaseAnchorManifest } from '@/lib/filecoin';

export const runtime = 'nodejs';

function getSupa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function POST(req: NextRequest) {
  const db = getSupa();
  if (!db) return NextResponse.json({ ok: false, error: 'supabase_unconfigured' }, { status: 500 });

  const { caseId } = await req.json();
  if (!caseId) return NextResponse.json({ ok: false, error: 'caseId required' }, { status: 400 });

  const { data: kase } = await db.from('cases').select('*').eq('id', caseId).single();
  if (!kase) return NextResponse.json({ ok: false, error: 'case not found' }, { status: 404 });

  const { data: events } = await db
    .from('pipeline_events')
    .select('agent,event,created_at')
    .eq('case_id', caseId)
    .order('created_at', { ascending: true })
    .limit(200);

  const desc = (kase.description || {}) as any;
  const manifest: CaseAnchorManifest = {
    version: 'argus-filecoin-v1',
    caseId,
    subject_name: desc.nombre || null,
    last_seen_zone: desc.ultima_ubicacion || null,
    last_seen_at: desc.fecha_desaparicion || null,
    portrait_sha256: kase.portrait_sha256 || null,
    events: (events || []).map((e: any) => ({ agent: e.agent, event: e.event, at: e.created_at })),
    anchored_at: new Date().toISOString(),
  };

  const result = await anchorCase(manifest);

  if (result.cid && result.cid !== 'local-only') {
    await db.from('cases').update({ evidence_cid: result.cid }).eq('id', caseId);
    await db.from('pipeline_events').insert({
      case_id: caseId,
      agent: 'pulse',
      event: 'complete',
      payload: { step: 'filecoin_anchor', cid: result.cid, url: result.url },
    });
  }

  return NextResponse.json({ ok: true, anchor: result });
}
