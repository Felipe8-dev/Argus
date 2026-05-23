// Argus realtime voice agent (LiveKit Agents + Gemini Live).
//
// This is a standalone worker process — NOT part of the Next.js app. It joins
// the same LiveKit room the browser is in (`argus-<caseId>`), runs the
// Spanish forensic-interview as a Gemini Live realtime session, and when it
// has gathered enough to act, calls the `launchArgusSearch` tool. That tool
// persists the structured case and signals the browser (over a LiveKit data
// message) to fire the LangGraph pipeline with the uploaded photo.
//
//   Browser mic ──► LiveKit room ──► Gemini Live (STT+brain+voice) ──► audio
//                        ▲                     │
//                        │ data: argus.ready   └──► Simli avatar (lip-sync)
//   Browser ◄────────────┘  → POST /api/launch-pipeline { caseId, photoUrl }
//
// Run:  npm run agent           (dev mode, hot reload)
//       npm run agent:start     (production)

import {
  cli,
  defineAgent,
  llm,
  voice,
  WorkerOptions,
  type JobContext,
} from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

// Load env the way the Next app does (this is a separate process). Node 21+
// ships process.loadEnvFile; fall back through .env.local → .env.
try {
  process.loadEnvFile('.env.local');
} catch {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* rely on the ambient environment */
  }
}

/* ------------------------------------------------------------------ */
/*  Interview persona (mirrors /api/agent-talk, adapted for realtime)  */
/* ------------------------------------------------------------------ */
const INSTRUCTIONS = `Eres "Radar", un investigador forense empático especializado en personas desaparecidas en Colombia. Hablas con calidez de costeño, tono cercano pero profesional. Esta es una conversación de voz en tiempo real: respuestas cortas, naturales, UNA pregunta por turno.

FLUJO DE LA ENTREVISTA (sé RÁPIDO)
1. Saluda breve, pregunta quién desapareció (nombre, relación) y pide INMEDIATAMENTE una foto reciente ("Si tienes una foto reciente, súbela con el botón de la cámara").
2. Pregunta los datos que falten: edad, género, color de piel, cabello, altura, ropa que llevaba.
3. Pregunta SIEMPRE dónde y cuándo desapareció (lugar concreto con referencias, fecha/hora).
4. Pregunta UNA seña particular (cicatriz, tatuaje, lunar, lentes).
5. Con nombre + (edad o género) + última ubicación + al menos 1 rasgo físico, YA TIENES SUFICIENTE.

REGLAS
- NUNCA inventes datos que el familiar no haya dicho. Si no lo sabes, déjalo vacío.
- No te extiendas. 1-2 frases por turno. Español colombiano costeño natural.
- Cuando tengas lo mínimo (nombre + ubicación + edad/género + 1 rasgo), di algo esperanzador breve ("Listo, ya tengo lo que necesito, voy a activar la búsqueda ya mismo") y LLAMA a la herramienta launchArgusSearch con todos los datos que recogiste. No anuncies la herramienta, solo úsala.`;

/* ------------------------------------------------------------------ */
/*  Supabase (case persistence)                                        */
/* ------------------------------------------------------------------ */
function getSupa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Broadcast a JSON event to everyone in the room (the browser listens). */
async function publish(ctx: JobContext, topic: string, data: Record<string, any>) {
  try {
    const payload = new TextEncoder().encode(JSON.stringify(data));
    await ctx.room.localParticipant?.publishData(payload, { reliable: true, topic });
  } catch (err) {
    console.error('[argus-agent] publishData failed:', err);
  }
}

/* ------------------------------------------------------------------ */
/*  Agent definition                                                   */
/* ------------------------------------------------------------------ */
export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log(`[argus-agent] joined room=${ctx.room.name}`);

    // Create the case up front so the browser can attach its photo + fire the
    // pipeline against a known id (mirrors what /api/agent-talk does today).
    const db = getSupa();
    let caseId = '';
    if (db) {
      const { data } = await db
        .from('cases')
        .insert({
          reporter_phone: 'web-agent',
          reporter_chat_id: 'web-agent',
          reporter_name: 'Demo Voz LiveKit',
          status: 'intake',
          description: {},
        })
        .select()
        .single();
      caseId = (data as any)?.id || '';
    }
    // Tell the browser which case this room belongs to.
    await publish(ctx, 'argus.case', { caseId });

    // Tool the model calls once it has gathered enough to act on.
    const launchArgusSearch = llm.tool({
      description:
        'Activa la búsqueda multi-agente. Llamar SOLO cuando ya tienes al menos: nombre, última ubicación, edad o género, y un rasgo físico.',
      parameters: z.object({
        nombre: z.string().describe('Nombre completo de la persona desaparecida'),
        edad_aprox: z.number().optional().describe('Edad aproximada en años'),
        genero: z.string().optional().describe('masculino / femenino / otro'),
        tono_piel: z.string().optional(),
        cabello: z.string().optional(),
        ojos: z.string().optional(),
        altura_cm: z.number().optional(),
        contextura: z.string().optional(),
        ropa: z.string().optional().describe('Ropa que llevaba al desaparecer'),
        senales_particulares: z.array(z.string()).optional().describe('Cicatrices, tatuajes, lunares, lentes'),
        ultima_ubicacion: z.string().describe('Lugar concreto donde se vio por última vez'),
        fecha_desaparicion: z.string().optional(),
        hora_aproximada: z.string().optional(),
        circunstancias: z.string().optional(),
      }),
      execute: async (description) => {
        console.log('[argus-agent] launchArgusSearch', JSON.stringify(description).slice(0, 200));
        if (db && caseId) {
          await db
            .from('cases')
            .update({ description, status: 'portrait', updated_at: new Date().toISOString() })
            .eq('id', caseId);
        }
        // Signal the browser: it owns the uploaded photo and the app origin,
        // so it triggers /api/launch-pipeline (LangGraph) from the client.
        await publish(ctx, 'argus.ready', { caseId, description });
        return 'Búsqueda activada. Los agentes ya están desplegados.';
      },
    });

    const model = new google.beta.realtime.RealtimeModel({
      model: process.env.GOOGLE_REALTIME_MODEL || 'gemini-2.0-flash-exp',
      apiKey: process.env.GEMINI_API_KEY,
      voice: process.env.GOOGLE_REALTIME_VOICE || 'Puck',
      language: process.env.GOOGLE_REALTIME_LANGUAGE || 'es-US',
      temperature: 0.8,
    });

    const agent = new voice.Agent({
      instructions: INSTRUCTIONS,
      tools: { launchArgusSearch },
    });

    const session = new voice.AgentSession({ llm: model });
    await session.start({ agent, room: ctx.room });

    // Open the conversation proactively.
    session.generateReply({
      instructions:
        'Saluda en español costeño, preséntate como Radar de ARGUS y pregunta quién desapareció. Una o dos frases.',
    });
  },
});

cli.runApp(new WorkerOptions({ agent: import.meta.filename }));
