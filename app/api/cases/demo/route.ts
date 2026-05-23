import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getSupa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const description = body.description || {};
  const phone = body.phone || process.env.DEMO_WHATSAPP_NUMBER || '3054879364';
  const authorityEmail = body.authorityEmail || process.env.AUTHORITY_ALERT_EMAIL || '';
  const db = getSupa();

  if (!db) {
    const caseId = `ARG-DEMO-${Date.now().toString().slice(-5)}`;
    return NextResponse.json({
      ok: true,
      simulated: true,
      caseId,
      phone,
      authorityEmail,
      description,
    });
  }

  const { data, error } = await db.from('cases').insert({
    reporter_phone: phone,
    reporter_chat_id: `${phone}@s.whatsapp.net`,
    reporter_name: 'Web ARGUS',
    status: 'intake',
    description,
  }).select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await db.from('pipeline_events').insert({
    case_id: data.id,
    agent: 'intake',
    event: 'complete',
    payload: { phone, authorityEmail, source: 'web' },
  });

  return NextResponse.json({ ok: true, caseId: data.id, phone, authorityEmail });
}
