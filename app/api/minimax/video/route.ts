import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getSupa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function buildPrompt(desc: Record<string, any>) {
  return [
    'Create a sober public safety alert video from this missing-person case banner.',
    'Keep the portrait and text visually stable; do not change the person face.',
    'Use subtle newsroom motion, map scan lines, emergency red accent, and clear institutional tone.',
    `Name: ${desc.nombre || 'unknown'}.`,
    `Last seen: ${desc.ultima_ubicacion || 'unknown location'}.`,
    `Clothing: ${desc.ropa || 'unknown'}.`,
    'The result must feel like a professional civic alert, not entertainment.',
  ].join(' ');
}

export async function POST(req: NextRequest) {
  if (process.env.MINIMAX_ENABLED === 'false') {
    return NextResponse.json({ ok: false, disabled: true, error: 'MINIMAX_ENABLED=false' }, { status: 400 });
  }

  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) return NextResponse.json({ ok: false, error: 'MINIMAX_API_KEY missing' }, { status: 500 });

  const db = getSupa();
  if (!db) return NextResponse.json({ ok: false, error: 'Supabase not configured' }, { status: 500 });

  const { caseId } = await req.json();
  if (!caseId) return NextResponse.json({ ok: false, error: 'No caseId' }, { status: 400 });

  const { data: kase } = await db.from('cases').select('*').eq('id', caseId).single();
  if (!kase) return NextResponse.json({ ok: false, error: 'Case not found' }, { status: 404 });

  const bannerUrl = `${req.nextUrl.origin}/api/banner/${caseId}`;
  const desc = kase.description || {};
  const payload = {
    model: process.env.MINIMAX_VIDEO_MODEL || 'MiniMax-Hailuo-2.3-Fast',
    first_frame_image: bannerUrl,
    prompt: buildPrompt(desc),
    duration: Number(process.env.MINIMAX_VIDEO_DURATION || 6),
    resolution: process.env.MINIMAX_VIDEO_RESOLUTION || '768P',
    prompt_optimizer: true,
  };

  await db.from('pipeline_events').insert({
    case_id: caseId,
    agent: 'agent3',
    event: 'progress',
    payload: { status: 'minimax_video_start', banner_url: bannerUrl },
  });

  const response = await fetch('https://api.minimax.io/v1/video_generation', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.task_id) {
    await db.from('pipeline_events').insert({
      case_id: caseId,
      agent: 'agent3',
      event: 'error',
      payload: { status: 'minimax_video_failed', response: data, http_status: response.status },
    });
    return NextResponse.json({ ok: false, status: response.status, data }, { status: response.status || 500 });
  }

  await db.from('pipeline_events').insert({
    case_id: caseId,
    agent: 'agent3',
    event: 'progress',
    payload: { status: 'minimax_video_queued', task_id: data.task_id, banner_url: bannerUrl },
  });

  return NextResponse.json({ ok: true, task_id: data.task_id, bannerUrl });
}
