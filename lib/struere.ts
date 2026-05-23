// Struere Agent Platform client.
// Docs: https://docs.struere.dev — TypeScript-native runtime for AI agents.
// We use it as a *second brain* for Argus: an operator-facing co-pilot that
// can be wired to any agent the user deploys on their Struere account, and as
// a durable audit ledger via the Data API.
//
// All calls fail soft: if the API is unreachable or the account doesn't have
// the requested resource yet, we return a structured `{ok:false, …}` and let
// the caller decide whether to fall back to Gemini / Supabase / nothing.

const BASE_URL = process.env.STRUERE_BASE_URL || 'https://api.struere.dev';

function getKey(): string | null {
  return (
    process.env.STRUERE_API_KEY ||
    process.env.STRUERE_KEY ||
    process.env.NEXT_PUBLIC_STRUERE_API_KEY ||
    null
  );
}

export function isConfigured(): boolean {
  return !!getKey();
}

async function request<T = any>(
  path: string,
  init: RequestInit & { json?: any } = {},
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  const key = getKey();
  if (!key) {
    return { ok: false, status: 0, data: null, error: 'STRUERE_API_KEY not configured' };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };

  let body: BodyInit | undefined = init.body ?? undefined;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, { ...init, headers, body });
  } catch (err: any) {
    return { ok: false, status: 0, data: null, error: err?.message || 'network error' };
  }

  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      data,
      error: data?.error?.message || data?.error || data?.message || `HTTP ${response.status}`,
    };
  }
  return { ok: true, status: response.status, data: data as T };
}

/* -------------------------------------------------------------------------- */
/*  Chat — talk to a deployed agent (slug or router)                          */
/* -------------------------------------------------------------------------- */

export interface ChatResult {
  ok: boolean;
  reply?: string;
  threadId?: string;
  tokensIn?: number;
  tokensOut?: number;
  agentSlug?: string;
  raw?: any;
  error?: string;
}

export async function chat(opts: {
  message: string;
  agentSlug?: string;
  routerSlug?: string;
  threadId?: string;
  externalThreadId?: string;
}): Promise<ChatResult> {
  const { message, agentSlug, routerSlug, threadId, externalThreadId } = opts;
  if (!message) return { ok: false, error: 'message required' };

  const path = agentSlug
    ? `/v1/agents/${encodeURIComponent(agentSlug)}/chat`
    : '/v1/chat';
  const body: Record<string, any> = { message };
  if (!agentSlug && routerSlug) body.routerSlug = routerSlug;
  if (threadId) body.threadId = threadId;
  if (externalThreadId) body.externalThreadId = externalThreadId;

  const res = await request<any>(path, { method: 'POST', json: body });
  if (!res.ok) return { ok: false, error: res.error, raw: res.data };

  const data = res.data || {};
  const reply =
    data.text ||
    data.message ||
    data.reply ||
    data.assistantMessage?.text ||
    data.output?.text ||
    '';
  return {
    ok: true,
    reply: String(reply || '').trim(),
    threadId: data.threadId || data.thread?.id,
    tokensIn: data.usage?.input || data.usage?.inputTokens,
    tokensOut: data.usage?.output || data.usage?.outputTokens,
    agentSlug,
    raw: data,
  };
}

/* -------------------------------------------------------------------------- */
/*  Data API — durable ledger / audit log                                     */
/* -------------------------------------------------------------------------- */

export async function createEntity(entityType: string, data: Record<string, any>) {
  return request(`/v1/data/${encodeURIComponent(entityType)}`, {
    method: 'POST',
    json: { data },
  });
}

export async function listEntities(entityType: string, limit = 25) {
  const qs = new URLSearchParams({ limit: String(limit) });
  return request(`/v1/data/${encodeURIComponent(entityType)}?${qs.toString()}`);
}

export async function searchEntities(entityType: string, query: string) {
  return request(`/v1/data/${encodeURIComponent(entityType)}/search`, {
    method: 'POST',
    json: { query },
  });
}

/* -------------------------------------------------------------------------- */
/*  Sync state — proves the integration is live without needing agents        */
/* -------------------------------------------------------------------------- */

export interface SyncState {
  agents: any[];
  entityTypes: any[];
  evalSuites: any[];
  roles: any[];
  routers: any[];
  tools: any[];
  triggers: any[];
}

export async function syncState() {
  return request<SyncState>('/v1/sync/state', { method: 'POST', json: {} });
}

export async function health() {
  return request<{ status: string; timestamp: number }>('/health', { method: 'GET' });
}

/* -------------------------------------------------------------------------- */
/*  Triggers — fire a webhook into a deployed Struere agent                   */
/* -------------------------------------------------------------------------- */

export async function fireTrigger(slug: string, payload: Record<string, any> = {}) {
  return request('/v1/fire-trigger', {
    method: 'POST',
    json: { slug, payload },
  });
}
