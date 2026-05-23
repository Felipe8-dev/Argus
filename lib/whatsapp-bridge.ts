// Argus → WhatsApp bridge client.
// The bridge lives on the operator's VPS (Baileys can't run on Vercel),
// exposes a token-protected HTTP API, and we POST to /send when we need
// to notify a number. All calls fail soft so the rest of the pipeline
// keeps moving if WhatsApp is offline.

const DEFAULT_TIMEOUT_MS = 8000;

function getConfig() {
  return {
    base: (process.env.WA_BRIDGE_URL || '').replace(/\/$/, ''),
    token: process.env.WA_BRIDGE_TOKEN || '',
  };
}

export function isConfigured() {
  const c = getConfig();
  return !!c.base && !!c.token;
}

export interface SendOpts {
  to: string;               // E.164 digits, "57…" — bridge normalizes
  text?: string;
  imageUrl?: string;
  audioUrl?: string;
  caption?: string;
}

export interface SendResult {
  ok: boolean;
  status: number;
  messageId?: string;
  to?: string;
  error?: string;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error('wa_bridge_timeout')), ms);
    p.then((v) => { clearTimeout(id); resolve(v); })
     .catch((e) => { clearTimeout(id); reject(e); });
  });
}

export async function send(opts: SendOpts): Promise<SendResult> {
  const cfg = getConfig();
  if (!cfg.base || !cfg.token) {
    return { ok: false, status: 0, error: 'wa_bridge_not_configured' };
  }
  if (!opts.to) return { ok: false, status: 400, error: 'to required' };

  try {
    const response = await withTimeout(
      fetch(`${cfg.base}/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(opts),
      }),
      DEFAULT_TIMEOUT_MS,
    );

    const text = await response.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: data?.error || `bridge ${response.status}`,
      };
    }
    return {
      ok: true,
      status: response.status,
      messageId: data?.messageId,
      to: data?.to,
    };
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message || 'bridge_unreachable' };
  }
}

export async function health(): Promise<{ ok: boolean; connected?: boolean; phone?: string | null; error?: string }> {
  const cfg = getConfig();
  if (!cfg.base) return { ok: false, error: 'wa_bridge_not_configured' };
  try {
    const r = await withTimeout(fetch(`${cfg.base}/health`), 4000);
    if (!r.ok) return { ok: false, error: `bridge ${r.status}` };
    const data = await r.json();
    return { ok: true, connected: !!data?.connected, phone: data?.phone || null };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'unreachable' };
  }
}
