import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { complete } from '@/lib/llm';

/* ------------------------------------------------------------------ */
/*  Agent 0 system prompt (mirrored from bot)                         */
/* ------------------------------------------------------------------ */
const SYSTEM_PROMPT = `Eres "Radar", un investigador forense empático especializado en personas desaparecidas en Colombia. Hablas con calidez de costeño, tono cercano pero profesional.

FLUJO DE LA ENTREVISTA (sé RÁPIDO, no te extiendas)
1. PRIMER MENSAJE: Saluda breve, pregunta quién desapareció (nombre, relación), y pregunta INMEDIATAMENTE: "¿Tienes alguna foto reciente de esa persona? Mándamela ya."
2. Si mandan foto: confírmala ("Listo, la recibí") y pregunta los datos que falten (edad, ropa, dónde/cuándo desapareció).
3. Si no tienen foto: pregunta rasgos físicos esenciales (edad, género, color de piel, cabello, altura, ropa que llevaba).
4. Siempre pregunta dónde y cuándo desapareció (lugar concreto con referencias, fecha/hora).
5. Pregunta UNA seña particular (cicatriz, tatuaje, lunar, forma de caminar, lentes).
6. Con eso BASTA. No sigas preguntando. EMITE LOS MARCADORES.

REGLAS CRÍTICAS
- NUNCA emitas los marcadores en los primeros 3 turnos. Necesitas al MÍNIMO: nombre, edad, género, última ubicación. Si no los tienes, PREGUNTA.
- NUNCA inventes datos que el familiar no te haya dicho. Si no sabes algo, pregúntalo o déjalo vacío.
- Después de 5-6 turnos, cierra con lo que tengas.
- Si el familiar ya dio: nombre + edad + al menos 2 rasgos físicos + última ubicación → puedes cerrar.
- UNA pregunta por turno. 1-2 frases máximo. Sin viñetas, sin markdown.
- Español colombiano costeño natural.
- Si el primer mensaje es un saludo casual ("hola", "ey bro"), responde presentándote y preguntando quién desapareció. NO cierres.

MARCADORES DE CIERRE
Cuando cierres, en tu mensaje:
1. Di algo esperanzador breve ("Listo hermano, ya tengo lo que necesito, voy a activar la búsqueda ya mismo.")
2. Al FINAL, en líneas separadas, agrega:

<EXTRACT>{"nombre":"...","edad_aprox":25,"genero":"masculino","tono_piel":"...","cabello":"...","ojos":"...","altura_cm":170,"contextura":"...","ropa":"...","senales_particulares":["..."],"ultima_ubicacion":"...","fecha_desaparicion":"...","hora_aproximada":"...","circunstancias":"..."}</EXTRACT>
<READY confidence="0.85"/>

- Omite campos que no sepas (no inventes).
- JSON válido, comillas dobles.
- Los marcadores van SIEMPRE al final.`;

const EXTRACT_RE = /<EXTRACT>([\s\S]*?)<\/EXTRACT>/i;
const READY_RE = /<READY\s+confidence\s*=\s*"?([0-9.]+)"?\s*\/?>/i;

/**
 * Returns a reason string when the interview is not ready to launch the
 * pipeline, or null when the gate passes. Keep the bar low enough that demos
 * still close, but high enough that a single "hola" cannot trigger the map.
 */
function validateInterview(
  description: any,
  history: { role: string; content: string }[],
): string | null {
  const userTurns = (history || []).filter((m) => m?.role === 'user').length;
  // The current user message is not in history yet, so count it.
  const effectiveTurns = userTurns + 1;
  if (effectiveTurns < 3) return `not_enough_turns:${effectiveTurns}`;
  if (!description || typeof description !== 'object') return 'no_description';

  const has = (key: string) =>
    description[key] !== undefined &&
    description[key] !== null &&
    String(description[key]).trim().length > 0;

  if (!has('nombre')) return 'missing_nombre';
  if (!has('ultima_ubicacion')) return 'missing_ultima_ubicacion';
  if (!has('edad_aprox') && !has('genero')) return 'missing_edad_or_genero';

  const traitFields = ['tono_piel', 'cabello', 'ojos', 'altura_cm', 'contextura', 'ropa'];
  const traitCount = traitFields.filter(has).length;
  const senalesCount = Array.isArray(description.senales_particulares)
    ? description.senales_particulares.filter((s: any) => String(s || '').trim().length > 0).length
    : 0;
  if (traitCount + senalesCount < 1) return 'missing_physical_traits';

  return null;
}

/* ------------------------------------------------------------------ */
/*  Supabase (optional, for event emission)                           */
/* ------------------------------------------------------------------ */
function getSupa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function emitEvent(caseId: string, agent: string, event: string, payload: any = {}) {
  const db = getSupa();
  if (!db) return;
  try { await db.from('pipeline_events').insert({ case_id: caseId, agent, event, payload }); } catch {}
}

/* ------------------------------------------------------------------ */
/*  POST handler                                                       */
/* ------------------------------------------------------------------ */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { text, history = [], caseId, phone } = body as {
    text: string;
    history: { role: string; content: string }[];
    caseId?: string;
    phone?: string;
  };

  if (!text) return NextResponse.json({ error: 'No text provided' }, { status: 400 });

  // Normalize whatever the operator typed in the phone modal into the
  // 10/12-digit string we store in cases.reporter_phone (no spaces, no
  // accents). WhatsApp bridge will country-code-prefix if needed.
  const cleanedPhone = (phone || '').replace(/\D/g, '').trim() || null;

  // Emit start event
  if (caseId) await emitEvent(caseId, 'agent0', 'start', { input_mode: 'voice_web' });

  // ---- Call LLM (MiniMax-M2 primary, Gemini fallback) ----
  let rawReply = '';
  let llmProvider = '';
  let llmModel = '';
  try {
    const result = await complete({
      system: SYSTEM_PROMPT,
      history: (history || []).map((m: any) => ({ role: m.role, content: m.content })),
      user: text,
      temperature: 0.8,
      maxTokens: 1024,
    });
    rawReply = result.text;
    llmProvider = result.provider;
    llmModel = result.model;
  } catch (err: any) {
    return NextResponse.json({ error: `LLM error: ${(err?.message || '').slice(0, 200)}` }, { status: 500 });
  }

  if (!rawReply) {
    return NextResponse.json({ error: 'LLM returned empty content' }, { status: 500 });
  }

  // ---- Parse markers ----
  let description: any = null;
  let readyForSearch = false;
  let confidence: number | null = null;

  const extractMatch = rawReply.match(EXTRACT_RE);
  if (extractMatch) {
    try { description = JSON.parse(extractMatch[1].trim()); } catch {}
  }
  const readyMatch = rawReply.match(READY_RE);
  if (readyMatch) {
    readyForSearch = true;
    confidence = Number(readyMatch[1]) || null;
  }

  // Server-side gate: the LLM sometimes fires <READY> too early. Block the
  // pipeline until we genuinely have enough to act on. If validation fails we
  // strip the marker and let the conversation continue.
  if (readyForSearch) {
    const reason = validateInterview(description, history);
    if (reason) {
      console.warn(`[agent-talk] readyForSearch overridden: ${reason}`);
      readyForSearch = false;
      confidence = null;
    }
  }

  // Strip markers from reply
  const reply = rawReply
    .replace(EXTRACT_RE, '')
    .replace(READY_RE, '')
    .trim();

  // Emit event
  if (caseId) {
    await emitEvent(caseId, 'agent0', readyForSearch ? 'complete' : 'progress', {
      has_description: !!description,
      ready: readyForSearch,
      confidence,
      nombre: description?.nombre,
    });
  }

  // ---- Persist case if we have supabase ----
  const db = getSupa();
  let activeCaseId = caseId;
  if (db && !activeCaseId) {
    const { data } = await db.from('cases').insert({
      reporter_phone: cleanedPhone || 'web-agent',
      reporter_chat_id: cleanedPhone || 'web-agent',
      reporter_name: 'Demo Web',
      status: 'intake',
      description: {},
    }).select().single();
    if (data) activeCaseId = data.id;
  } else if (db && activeCaseId && cleanedPhone) {
    // Operator filled in the phone modal *after* the case was created.
    // Patch reporter_phone so downstream WA fan-out can find a real number.
    try {
      await db.from('cases').update({
        reporter_phone: cleanedPhone,
        reporter_chat_id: cleanedPhone,
      }).eq('id', activeCaseId).eq('reporter_phone', 'web-agent');
    } catch {}
  }
  if (db && activeCaseId && description) {
    await db.from('cases').update({
      description,
      status: readyForSearch ? 'portrait' : 'intake',
      updated_at: new Date().toISOString(),
    }).eq('id', activeCaseId);
  }

  // ---- Generate TTS with ElevenLabs (key rotation) ----
  // We get both MP3 (for fallback playback) and PCM (for Simli lip sync)
  let audioMp3Base64: string | null = null;
  let audioPcmBase64: string | null = null;
  const elevenKeys = Array.from(new Set([
    process.env.ELEVENLABS_API_KEY,
    process.env.ELEVENLABS_API_KEY_2,
    process.env.ELEVENLABS_API_KEY_3,
    process.env.ELEVENLABS_API_KEY_4,
    ...(process.env.ELEVENLABS_API_KEYS || '').split(','),
  ].map((key) => key?.trim()).filter(Boolean))) as string[];
  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'cgSgspJ2msm6clMCkdW9';

  if (elevenKeys.length > 0 && reply) {
    const ttsText = reply.slice(0, 600);
    const modelId = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
    console.log(`[agent-talk] ElevenLabs keys available=${elevenKeys.length} voice=${voiceId}`);
    for (const key of elevenKeys) {
      try {
        // MP3 is the safest output for free/demo accounts. PCM is optional for Simli lip sync.
        const mp3Res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'xi-api-key': key },
          body: JSON.stringify({
            text: ttsText,
            model_id: modelId,
            voice_settings: { stability: 0.45, similarity_boost: 0.8 },
          }),
        });

        if (!mp3Res.ok) {
          const mp3Err = await mp3Res.text().catch(() => '');
          console.error(`ElevenLabs MP3 key ${key.slice(0, 8)}... error ${mp3Res.status}: ${mp3Err.slice(0, 100)}`);
          continue;
        }

        audioMp3Base64 = Buffer.from(await mp3Res.arrayBuffer()).toString('base64');

        const pcmRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_16000`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'xi-api-key': key },
          body: JSON.stringify({
            text: ttsText,
            model_id: modelId,
            voice_settings: { stability: 0.45, similarity_boost: 0.8 },
          }),
        });

        if (pcmRes.ok) {
          audioPcmBase64 = Buffer.from(await pcmRes.arrayBuffer()).toString('base64');
        } else {
          const pcmErr = await pcmRes.text().catch(() => '');
          console.error(`ElevenLabs PCM key ${key.slice(0, 8)}... error ${pcmRes.status}: ${pcmErr.slice(0, 100)}`);
        }

        break;
      } catch (err) {
        console.error('ElevenLabs TTS error:', err);
      }
    }
  }

  // ---- Fallback a MiniMax TTS si ElevenLabs no devolvió audio ----
  // ElevenLabs free tier se agota rápido. MiniMax (plan del user) es
  // ilimitado y soporta español + PCM para Simli lip-sync.
  if (!audioMp3Base64 && reply) {
    try {
      const { synthesizeMiniMax } = await import('@/lib/tts');
      const mm = await synthesizeMiniMax(reply);
      if (mm.mp3Base64) {
        audioMp3Base64 = mm.mp3Base64;
        if (mm.pcmBase64) audioPcmBase64 = mm.pcmBase64;
        console.log(`[agent-talk] MiniMax TTS fallback OK mp3=${mm.mp3Base64.length} pcm=${mm.pcmBase64?.length || 0}${mm.error ? ` (warn: ${mm.error})` : ''}`);
      } else {
        console.warn(`[agent-talk] MiniMax TTS fallback failed: ${mm.error}`);
      }
    } catch (err: any) {
      console.error('[agent-talk] MiniMax TTS exception:', err?.message);
    }
  }

  console.log(`[agent-talk] provider=${llmProvider}:${llmModel} reply=${reply.slice(0,80)}... pcm=${audioPcmBase64 ? audioPcmBase64.length : 0} mp3=${audioMp3Base64 ? audioMp3Base64.length : 0} caseId=${activeCaseId}`);

  return NextResponse.json({
    reply,
    audioPcmBase64,
    audioMp3Base64,
    description,
    readyForSearch,
    confidence,
    caseId: activeCaseId || null,
  });
}
