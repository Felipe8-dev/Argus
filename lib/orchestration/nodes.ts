// Argus orchestration nodes.
//
// Each node is a thin, typed wrapper around an existing agent endpoint. The
// agents themselves are unchanged — LangGraph only replaces the orchestration
// glue (ordering, conditional gating, shared state, retries) that used to live
// as fire-and-forget `fetch()` calls in launch-pipeline.

import { createClient } from '@supabase/supabase-js';
import type { CaseStateType, CaseUpdate } from './state';

/* ------------------------------------------------------------------ */
/*  helpers                                                            */
/* ------------------------------------------------------------------ */

function getSupa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function emit(caseId: string, agent: string, event: string, payload: any = {}) {
  const db = getSupa();
  if (!db) return;
  try {
    await db.from('pipeline_events').insert({ case_id: caseId, agent, event, payload });
  } catch {
    /* best-effort telemetry */
  }
}

/**
 * POST to an internal agent endpoint and parse JSON, never throwing.
 *
 * Retries transient network failures (a few attempts with linear backoff) and,
 * if the endpoint is still unreachable, returns a structured error instead of
 * throwing. This keeps one failing agent from aborting the whole orchestration:
 * its branch degrades to a recorded no-op while the other agents run to
 * completion — the resilience the graph comment promises.
 */
async function post(origin: string, path: string, body: any, attempts = 2): Promise<any> {
  let lastErr: any;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json().catch(() => ({ ok: res.ok, status: res.status }));
    } catch (err: any) {
      lastErr = err;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  return { ok: false, error: `request_failed:${lastErr?.message || 'unknown'}`, path };
}

/* ------------------------------------------------------------------ */
/*  nodes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Provenance gate. Classifies the portrait (EXIF + dHash + Gemini deepfake
 * classifier). A `suspect` verdict blocks public Facebook publishing so a
 * poisoned/deepfaked image never goes out under the operator's page.
 */
export async function provenanceNode(state: CaseStateType): Promise<CaseUpdate> {
  if (!state.photoUrl) {
    return { provenance: { verdict: 'unknown' } };
  }
  try {
    const data = await post(state.origin, '/api/intel/provenance', {
      caseId: state.caseId,
      photoUrl: state.photoUrl,
    });
    const verdict = (data?.verdict || data?.result?.verdict || 'unknown') as
      | 'verified'
      | 'suspect'
      | 'unknown';
    await emit(state.caseId, 'intel.provenance', 'complete', { verdict });
    return { provenance: { verdict, score: data?.score } };
  } catch (err: any) {
    return { provenance: { verdict: 'unknown' }, errors: [`provenance:${err?.message}`] };
  }
}

/** Atlas — probable search sectors + outward path. Geo-gated. */
export async function atlasNode(state: CaseStateType): Promise<CaseUpdate> {
  if (!state.geo) return {};
  const data = await post(state.origin, '/api/agents/atlas', {
    caseId: state.caseId,
    lat: state.geo.gps_lat,
    lng: state.geo.gps_lon,
  });
  return { results: { atlas: data } };
}

/** Intel context layers — GDELT + OSM Overpass run in parallel. Geo-gated. */
export async function intelNode(state: CaseStateType): Promise<CaseUpdate> {
  if (!state.geo) return {};
  const body = { caseId: state.caseId, lat: state.geo.gps_lat, lng: state.geo.gps_lon };
  const [gdelt, overpass] = await Promise.all([
    post(state.origin, '/api/intel/gdelt', body),
    post(state.origin, '/api/intel/overpass', body),
  ]);
  return { results: { gdelt, overpass } };
}

/** Ghost.social — public-only social OSINT. Needs a name, not geo. */
export async function osintSocialNode(state: CaseStateType): Promise<CaseUpdate> {
  if (!state.description?.nombre) return {};
  const data = await post(state.origin, '/api/osint/social', {
    caseId: state.caseId,
    description: state.description,
  });
  return { results: { osintSocial: data } };
}

/** Pulse heartbeat + family WhatsApp ping. Geo-gated. */
export async function pulseNode(state: CaseStateType): Promise<CaseUpdate> {
  if (!state.geo) return {};
  const out: Record<string, any> = {};

  out.pulse = await post(state.origin, '/api/agents/pulse-watch', {
    caseId: state.caseId,
    lat: state.geo.gps_lat,
    lng: state.geo.gps_lon,
    channels: ['whatsapp', 'email'],
  });

  // Family ping — reads reporter_phone from the case row.
  const db = getSupa();
  if (db) {
    try {
      const { data: kase } = await db
        .from('cases')
        .select('reporter_phone')
        .eq('id', state.caseId)
        .single();
      const phone = (kase as any)?.reporter_phone;
      if (phone && phone !== 'web-agent') {
        out.familyPing = await post(state.origin, '/api/whatsapp/send', {
          caseId: state.caseId,
          to: phone,
          kind: 'alert',
          text:
            `🛰️ ARGUS activado para ${state.description?.nombre || 'tu caso'}.\n` +
            `Última ubicación: ${state.geo.place_label}.\n` +
            `Agentes desplegados. Te aviso si hay coincidencia.\n` +
            `Mapa en vivo: ${state.origin}/`,
        });
      }
    } catch {
      /* no phone, skip */
    }
  }
  return { results: out };
}

/**
 * Publish the alert banner to Facebook — GATED by the provenance verdict.
 * If the portrait is `suspect`, we refuse to publish it publicly and log the
 * decision instead of pushing a possibly-deepfaked image under the page.
 */
export async function publishNode(state: CaseStateType): Promise<CaseUpdate> {
  if (state.provenance?.verdict === 'suspect') {
    await emit(state.caseId, 'echo.publish', 'blocked', {
      reason: 'provenance_suspect',
      note: 'Portrait flagged as suspect; skipping public Facebook publish.',
    });
    return { results: { publish: { ok: false, skipped: true, reason: 'provenance_suspect' } } };
  }
  const data = await post(state.origin, '/api/publish', { caseId: state.caseId });
  return { results: { publish: data } };
}

/** Authority email alert. Always runs (even if FB publish was gated). */
export async function alertNode(state: CaseStateType): Promise<CaseUpdate> {
  const data = await post(state.origin, '/api/alert-authorities', {
    caseId: state.caseId,
    authorityEmail: state.authorityEmail,
    description: state.description,
    photoUrl: state.photoUrl,
    bannerUrl: state.bannerUrl,
    mapUrl: state.geo
      ? `https://www.google.com/maps/search/?api=1&query=${state.geo.gps_lat},${state.geo.gps_lon}`
      : undefined,
    match: {
      location: state.geo?.place_label || state.description?.ultima_ubicacion || 'Zona reportada',
      confidence: 0.65,
      ...(state.geo || {}),
    },
  });
  return { results: { alert: data } };
}

/** Optional MiniMax animated banner video. */
export async function videoNode(state: CaseStateType): Promise<CaseUpdate> {
  if (process.env.MINIMAX_ENABLED !== 'true') return {};
  const data = await post(state.origin, '/api/minimax/video', { caseId: state.caseId });
  return { results: { video: data } };
}

/**
 * Ghost (vision) — per-image facial comparison. The long-running node
 * (one MiniMax/Gemini call per candidate photo). Photo-gated.
 */
export async function visionSearchNode(state: CaseStateType): Promise<CaseUpdate> {
  if (!state.photoUrl) return {};
  const data = await post(state.origin, '/api/search', {
    caseId: state.caseId,
    authorityEmail: state.authorityEmail,
  });
  return { results: { search: data } };
}

/**
 * Sentinel — cluster + trafficking-pattern detector. Runs AFTER vision search
 * so it sees the freshly inserted matches. This replaces the legacy
 * `setTimeout(8000)` hack with a real ordering edge.
 */
export async function sentinelNode(state: CaseStateType): Promise<CaseUpdate> {
  const data = await post(state.origin, '/api/agents/sentinel', { caseId: state.caseId });
  return { results: { sentinel: data } };
}

/** Filecoin/IPFS evidence anchor — final manifest of the case. */
export async function anchorNode(state: CaseStateType): Promise<CaseUpdate> {
  const data = await post(state.origin, '/api/case/anchor', { caseId: state.caseId });
  await emit(state.caseId, 'pipeline', 'complete', { status: 'orchestration_complete' });
  return { results: { anchor: data } };
}
