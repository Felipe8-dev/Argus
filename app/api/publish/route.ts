import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { publishToFacebook } from '@/lib/facebook';
import { complete } from '@/lib/llm';
import { withSpan } from '@/lib/trace';

function getSupa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function fallbackCopy(desc: Record<string, any>) {
  return [
    'ALERTA ARGUS',
    `${desc.nombre || 'Nombre por confirmar'}, ${desc.edad_aprox || '?'} anos.`,
    `Ultima vez visto en ${desc.ultima_ubicacion || 'ubicacion por confirmar'}.`,
    `Ropa: ${desc.ropa || 'por confirmar'}.`,
    'Si tienes informacion, contacta a las autoridades. #Argus #Cartagena #Busqueda',
  ].join('\n');
}

async function generateCopy(desc: Record<string, any>) {
  const prompt = `Genera un post sobrio para una alerta de busqueda de persona desaparecida en Cartagena, Colombia.
Datos:
- Nombre: ${desc.nombre || 'Desconocido'}
- Edad: ${desc.edad_aprox || '?'} anos
- Genero: ${desc.genero || '?'}
- Cabello: ${desc.cabello || '?'}
- Ultima ubicacion: ${desc.ultima_ubicacion || '?'}
- Fecha desaparicion: ${desc.fecha_desaparicion || '?'}
- Senas: ${(desc.senales_particulares || []).join(', ') || 'ninguna reportada'}
- Ropa: ${desc.ropa || '?'}

Escribe SOLO el texto del post, maximo 5 lineas. Tono institucional, humano y claro. Sin markdown ni comillas.`;

  try {
    const result = await complete({ user: prompt, temperature: 0.55, maxTokens: 260 });
    if (result.text) return result.text;
  } catch (err: any) {
    console.error(`[publish] copy fallback: ${err?.message?.slice(0, 160)}`);
  }
  return fallbackCopy(desc);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return withSpan<NextResponse>('agent.echo.publish', { attrs: { method: 'POST' } }, async (span) => {
  const db = getSupa();
  if (!db) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const { caseId } = await req.json();
  if (!caseId) return NextResponse.json({ error: 'No caseId' }, { status: 400 });
  span.attrs.case_id = caseId;
  const origin = req.nextUrl.origin;

  const { data: kase } = await db.from('cases').select('*').eq('id', caseId).single();
  if (!kase) return NextResponse.json({ error: 'Case not found' }, { status: 404 });

  const desc = kase.description || {};
  const photoUrl = kase.portrait_url || null;
  const bannerUrl = `${origin}/api/banner/${caseId}`;

  await db.from('pipeline_events').insert({
    case_id: caseId,
    agent: 'agent3',
    event: 'start',
    payload: { step: 'facebook_publish' },
  });

  const copy = await generateCopy(desc);
  const facebook = await publishToFacebook(copy, bannerUrl, photoUrl);
  const platform = facebook.enabled ? 'facebook' : 'facebook-ready';

  await db.from('viral_posts').insert({
    case_id: caseId,
    platform,
    copy,
    image_url: bannerUrl,
  });

  await db.from('pipeline_events').insert({
    case_id: caseId,
    agent: 'agent3',
    event: facebook.enabled && facebook.ok === false ? 'error' : 'complete',
    payload: {
      platform,
      facebook,
      banner_url: bannerUrl,
      portrait_url: photoUrl,
      status: facebook.enabled ? 'publish_attempted' : 'copy_ready',
    },
  });

  // Try to derive a public URL for the published post so the operator can
  // hand it to /api/osint/harvest. Graph returns `{id: "<pageid>_<postid>"}`.
  let postUrl: string | null = null;
  const rawId = facebook?.id || facebook?.raw?.post_id || facebook?.raw?.id;
  if (rawId && typeof rawId === 'string') {
    const numeric = rawId.split('_').pop();
    if (numeric) postUrl = `https://www.facebook.com/${process.env.FACEBOOK_PAGE_ID}/posts/${numeric}`;
  }

  // Auto-schedule harvests at +30s and +5min so witness tips coming in
  // shortly after publication get captured without operator action.
  // Both calls are fire-and-forget; nothing here blocks the response.
  if (postUrl) {
    const origin = req.nextUrl.origin;
    setTimeout(() => {
      fetch(`${origin}/api/osint/harvest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId, postUrl }),
      }).catch(() => {});
    }, 30_000);
    setTimeout(() => {
      fetch(`${origin}/api/osint/harvest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId, postUrl }),
      }).catch(() => {});
    }, 5 * 60_000);
  }

  span.attrs.published = !!(facebook?.id || facebook?.raw?.post_id);
  return NextResponse.json({ ok: true, copy, facebook, bannerUrl, postUrl });
  });
}
