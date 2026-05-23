// Unified LLM client: MiniMax-M2 (operator's unlimited plan) primary,
// Gemini 2.0/2.5 Flash as fallback. Used by agent-talk + publish copy
// generators + publish-found copy generator so the demo doesn't die on
// Gemini's 20-req/day free quota.

const MINIMAX_ENDPOINT = 'https://api.minimax.io/v1/text/chatcompletion_v2';

const GEMINI_KEYS = Array.from(new Set([
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  ...(process.env.GEMINI_API_KEYS || '').split(','),
].map((k) => k?.trim()).filter(Boolean))) as string[];

let geminiIdx = 0;
function nextGeminiKey(): string | null {
  if (!GEMINI_KEYS.length) return null;
  const key = GEMINI_KEYS[geminiIdx % GEMINI_KEYS.length];
  geminiIdx++;
  return key;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteOpts {
  system?: string;
  history?: ChatMessage[];
  user: string;
  temperature?: number;
  maxTokens?: number;
  /** Force a provider; default tries MiniMax first then Gemini. */
  preferProvider?: 'minimax' | 'gemini';
}

export interface CompletionResult {
  text: string;
  provider: 'minimax' | 'gemini';
  model: string;
}

/* -------------------------------------------------------------------------- */
/*  MiniMax-M2                                                                */
/* -------------------------------------------------------------------------- */

async function callMinimax(opts: CompleteOpts): Promise<CompletionResult> {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error('MINIMAX_API_KEY missing');
  const model = process.env.MINIMAX_TEXT_MODEL || 'MiniMax-M2';

  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.history || []) messages.push({ role: m.role, content: m.content });
  messages.push({ role: 'user', content: opts.user });

  const response = await fetch(MINIMAX_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.55,
      max_tokens: opts.maxTokens ?? 1024,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`minimax http ${response.status}: ${body.slice(0, 160)}`);
  }
  const data = await response.json();
  if (data?.base_resp?.status_code && data.base_resp.status_code !== 0) {
    throw new Error(`minimax api ${data.base_resp.status_code}: ${(data.base_resp.status_msg || '').slice(0, 160)}`);
  }
  const text = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('minimax returned empty content');
  return { text, provider: 'minimax', model };
}

/* -------------------------------------------------------------------------- */
/*  Gemini Flash (fallback)                                                   */
/* -------------------------------------------------------------------------- */

async function callGemini(opts: CompleteOpts): Promise<CompletionResult> {
  if (!GEMINI_KEYS.length) throw new Error('No GEMINI_API_KEY configured');
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  const contents = [
    ...(opts.history || []).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    { role: 'user', parts: [{ text: opts.user }] },
  ];
  const body: any = {
    contents,
    generationConfig: {
      maxOutputTokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.55,
    },
  };
  if (opts.system) body.system_instruction = { parts: [{ text: opts.system }] };

  let lastError = '';
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const key = nextGeminiKey();
    if (!key) break;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (response.ok) {
      const data = await response.json();
      const text = String(data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      if (text) return { text, provider: 'gemini', model };
      lastError = 'gemini empty content';
      continue;
    }
    lastError = (await response.text().catch(() => '')).slice(0, 200);
    if (response.status !== 429) break;
  }
  throw new Error(`gemini failed: ${lastError}`);
}

/* -------------------------------------------------------------------------- */
/*  Orchestrator                                                              */
/* -------------------------------------------------------------------------- */

export async function complete(opts: CompleteOpts): Promise<CompletionResult> {
  const order: Array<'minimax' | 'gemini'> = opts.preferProvider
    ? [opts.preferProvider, opts.preferProvider === 'minimax' ? 'gemini' : 'minimax']
    : ['minimax', 'gemini'];

  let lastErr: any = null;
  for (const provider of order) {
    try {
      if (provider === 'minimax') return await callMinimax(opts);
      return await callGemini(opts);
    } catch (err) {
      lastErr = err;
      console.warn(`[llm] ${provider} failed: ${(err as Error).message}`);
    }
  }
  throw lastErr || new Error('no LLM provider succeeded');
}
