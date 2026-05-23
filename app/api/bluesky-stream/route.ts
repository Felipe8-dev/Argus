import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  JETSTREAM_ENDPOINT,
  matchPost,
  buildBlueskyUrl,
  fetchHistoricalPosts,
  type BlueskyFilters,
  type BlueskyPost,
} from '@/lib/bluesky';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getSupa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function loadFilters(caseId: string | null): Promise<BlueskyFilters> {
  if (!caseId) return {};
  const db = getSupa();
  if (!db) return {};
  const { data } = await db.from('cases').select('description').eq('id', caseId).single();
  const desc = (data?.description || {}) as any;
  return {
    subjectName: desc?.nombre || null,
    zone: desc?.ultima_ubicacion || null,
  };
}

/**
 * SSE proxy hacia Jetstream con filtro por caso. Cliente abre EventSource.
 * Cualquier post matched llega como `data: {json}\n\n`.
 *
 * Fallback: a los 20s sin live matches, emite hasta 5 posts históricos vía
 * REST searchPosts para que el panel nunca esté vacío en el demo. Estos
 * vienen etiquetados source='historical' para no fingir tiempo real.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const caseId = url.searchParams.get('caseId');
  const filters = await loadFilters(caseId);

  const encoder = new TextEncoder();
  let ws: any = null;
  let closed = false;
  let liveCount = 0;
  let emitCount = 0;
  let lastEmit = 0;

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (payload: BlueskyPost) => {
        if (closed) return;
        const now = Date.now();
        // Rate limit: max 5/s aggregate, drop excess.
        if (now - lastEmit < 200 && emitCount > 0 && now - lastEmit > 0) return;
        lastEmit = now;
        emitCount++;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };

      enqueue({
        at: new Date().toISOString(),
        did: 'system',
        text: `Escuchando Jetstream… filtros: nombre=${filters.subjectName || '∅'} zona=${filters.zone || '∅'}`,
        uri: '',
        reason: 'system',
        source: 'live',
      } as any);

      // Try to attach WebSocket. Node 18+/Next has global WebSocket via undici.
      try {
        const WS = (globalThis as any).WebSocket || (await import('ws')).default;
        ws = new WS(JETSTREAM_ENDPOINT);

        ws.onmessage = (event: any) => {
          try {
            const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
            if (msg.kind !== 'commit' || msg.commit?.collection !== 'app.bsky.feed.post') return;
            const record = msg.commit?.record;
            const text = record?.text || '';
            const verdict = matchPost(text, filters);
            if (!verdict.match) return;
            liveCount++;
            const did = msg.did || '';
            const rkey = msg.commit?.rkey || '';
            const uri = rkey ? `at://${did}/app.bsky.feed.post/${rkey}` : '';
            enqueue({
              at: new Date(msg.time_us ? msg.time_us / 1000 : Date.now()).toISOString(),
              did,
              text: text.slice(0, 280),
              uri,
              lang: record?.langs?.[0],
              reason: verdict.reason,
              source: 'live',
              ...(uri ? { permalink: buildBlueskyUrl(did, uri) } : {}),
            } as any);
          } catch {
            // ignore malformed
          }
        };

        ws.onerror = (err: any) => {
          if (process.env.TRACE_DEBUG) console.warn('[bluesky] ws error:', err?.message);
        };
      } catch (err: any) {
        console.warn('[bluesky] ws connect failed, fallback only:', err?.message);
      }

      // Fallback histórico tras 20s sin matches.
      setTimeout(async () => {
        if (closed || liveCount > 0) return;
        const query = filters.subjectName || filters.zone || 'desaparecida';
        const posts = await fetchHistoricalPosts(query, 5);
        for (const p of posts) {
          enqueue(p);
        }
      }, 20_000);

      req.signal.addEventListener('abort', () => {
        closed = true;
        try { ws?.close(); } catch {}
        try { controller.close(); } catch {}
      });
    },

    cancel() {
      closed = true;
      try { ws?.close(); } catch {}
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
