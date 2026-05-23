import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { publishToFacebook } from '@/lib/facebook';
import { complete } from '@/lib/llm';

function getSupa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function fallbackFoundCopy(desc: Record<string, any>, match: any) {
  const name = desc.nombre || 'Persona desaparecida';
  const place = match?.place_label || desc.ultima_ubicacion || 'una ubicacion identificada';
  return [
    'PERSONA ENCONTRADA - ALERTA ARGUS',
    `Se identifico una posible coincidencia visual de ${name}.`,
    `Zona: ${place}.`,
    'Las autoridades fueron notificadas para verificacion humana.',
    'Gracias a la red ARGUS. #Argus #Encontrado',
  ].join('\n');
}

async function generateFoundCopy(desc: Record<string, any>, match: any) {
  const prompt = `Genera un post sobrio para Facebook anunciando que ARGUS (red de respuesta temprana civil)
identifico una posible coincidencia visual de una persona desaparecida.
Tono institucional, esperanzador pero responsable. Aclarar que requiere verificacion humana.

Datos:
- Nombre: ${desc.nombre || 'Desconocido'}
- Edad: ${desc.edad_aprox || '?'} anos
- Ultima ubicacion reportada: ${desc.ultima_ubicacion || '?'}
- Zona del hallazgo: ${match?.place_label || 'no especificada'}
- Fuente: ${match?.source_site || 'fuente publica'}
- Confianza IA: ${match?.confidence ? Math.round(match.confidence * 100) + '%' : '?'}

Escribe SOLO el texto del post, maximo 6 lineas. Sin markdown ni comillas. Sin asegurar
que es la persona; usar "posible coincidencia" o "presunta identificacion".`;

  try {
    const result = await complete({ user: prompt, temperature: 0.45, maxTokens: 300 });
    if (result.text) return result.text;
  } catch (err: any) {
    console.error(`[publish-found] copy fallback: ${err?.message?.slice(0, 160)}`);
  }
  return fallbackFoundCopy(desc, match);
}

export async function POST(req: NextRequest) {
  const db = getSupa();
  if (!db) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const { caseId, matchId, authorityEmail } = await req.json();
  if (!caseId) return NextResponse.json({ error: 'No caseId' }, { status: 400 });
  const origin = req.nextUrl.origin;

  const { data: kase } = await db.from('cases').select('*').eq('id', caseId).single();
  if (!kase) return NextResponse.json({ error: 'Case not found' }, { status: 404 });

  // Pick the specific match passed in, or the best one for this case
  let match: any = null;
  if (matchId) {
    const { data } = await db.from('matches').select('*').eq('id', matchId).single();
    match = data;
  }
  if (!match) {
    const { data } = await db
      .from('matches')
      .select('*')
      .eq('case_id', caseId)
      .order('confidence', { ascending: false })
      .limit(1)
      .single();
    match = data;
  }
  if (!match) return NextResponse.json({ error: 'No match available for this case' }, { status: 404 });

  // Guard against double-publishing the same match.
  if (match.notified) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'match already notified', matchId: match.id });
  }

  const desc = kase.description || {};
  const foundBannerUrl = `${origin}/api/banner-found/${caseId}`;

  await db.from('pipeline_events').insert({
    case_id: caseId,
    agent: 'agent3',
    event: 'start',
    payload: { step: 'facebook_publish_found', match_id: match.id, confidence: match.confidence },
  });

  const copy = await generateFoundCopy(desc, match);

  // Facebook: prefer the found-banner; fall back to the match photo itself if the banner fails.
  const facebook = await publishToFacebook(copy, foundBannerUrl, match.photo_url || kase.portrait_url || null);

  await db.from('viral_posts').insert({
    case_id: caseId,
    platform: facebook.enabled ? 'facebook-found' : 'facebook-found-ready',
    copy,
    image_url: foundBannerUrl,
  });

  // Email — same alert-authorities endpoint with kind=found.
  let email: any = null;
  try {
    const mapUrl = match.gps_lat && match.gps_lon
      ? `https://www.google.com/maps/search/?api=1&query=${match.gps_lat},${match.gps_lon}`
      : undefined;
    const alertRes = await fetch(`${origin}/api/alert-authorities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        caseId,
        authorityEmail,
        kind: 'found',
        description: desc,
        photoUrl: kase.portrait_url,
        bannerUrl: foundBannerUrl,
        mapUrl,
        match: {
          place_label: match.place_label,
          source_site: match.source_site,
          source_url: match.source_url,
          photo_url: match.photo_url,
          confidence: match.confidence,
          gps_lat: match.gps_lat,
          gps_lon: match.gps_lon,
        },
      }),
    });
    email = await alertRes.json().catch(() => ({ ok: false, error: 'invalid alert json' }));
  } catch (err: any) {
    email = { ok: false, error: err.message };
  }

  // WhatsApp: ping the reporter (family) with the found photo + map.
  // Bridge runs on the operator's VPS. Fire-and-forget — pipeline keeps
  // going even if WA is offline.
  try {
    const reporter = kase.reporter_phone;
    if (reporter && reporter !== 'web-agent') {
      const place = match.place_label || 'una zona priorizada';
      const mapUrl = match.gps_lat && match.gps_lon
        ? `https://www.google.com/maps/search/?api=1&query=${match.gps_lat},${match.gps_lon}`
        : '';
      const txt =
        `🟢 ARGUS — posible coincidencia\n` +
        `${desc.nombre || 'La persona reportada'} fue identificada con confianza ${Math.round(Number(match.confidence) * 100)}% en ${place}.\n` +
        (mapUrl ? `Ubicación: ${mapUrl}\n` : '') +
        `Verificación humana en curso. Autoridades notificadas.`;
      fetch(`${origin}/api/whatsapp/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseId,
          to: reporter,
          kind: 'found',
          imageUrl: match.photo_url,
          caption: txt,
        }),
      }).catch((err) => console.error('[publish-found] wa family:', err?.message));
    }
  } catch {}

  // Mark the match as notified so it isn't republished on the next sweep.
  await db.from('matches').update({ notified: true }).eq('id', match.id);

  // Move case status forward.
  await db.from('cases').update({
    status: 'match_found',
    updated_at: new Date().toISOString(),
  }).eq('id', caseId);

  await db.from('pipeline_events').insert({
    case_id: caseId,
    agent: 'agent3',
    event: facebook.enabled && facebook.ok === false ? 'error' : 'complete',
    payload: {
      step: 'facebook_publish_found',
      facebook,
      email,
      found_banner_url: foundBannerUrl,
      match_id: match.id,
      gps_lat: match.gps_lat,
      gps_lon: match.gps_lon,
      place_label: match.place_label,
      confidence: match.confidence,
    },
  });

  return NextResponse.json({ ok: true, copy, facebook, email, foundBannerUrl, match });
}
