import { NextRequest, NextResponse } from 'next/server';
import { chat, isConfigured } from '@/lib/struere';
import { emit, getSupa } from '@/lib/argus-server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Operator co-pilot powered by Struere.
 *
 * The operator types a question in the dashboard ("dame contexto del caso
 * actual", "que zonas tienen mas riesgo ahora", "que organismo activo en
 * Cartagena puede ayudar") and we route it through the Struere agent the
 * defender deployed on their account. We piggyback the active case into the
 * message so the agent has context.
 *
 * If no agent is configured / deployed we fall back to Gemini via the
 * existing /api/agent-talk endpoint so the demo never dies.
 */

const FALLBACK_AGENT = process.env.STRUERE_AGENT_SLUG || 'argus-ops';
const FALLBACK_ROUTER = process.env.STRUERE_ROUTER_SLUG || '';

export async function POST(req: NextRequest) {
  const { message, caseId, threadId, externalThreadId, contextSummary } = await req.json();
  if (!message) return NextResponse.json({ error: 'message required' }, { status: 400 });

  if (!isConfigured()) {
    return NextResponse.json({
      ok: false,
      provider: 'struere',
      error: 'STRUERE_API_KEY not configured',
    }, { status: 503 });
  }

  const db = getSupa();
  if (caseId) await emit(db, caseId, 'struere', 'start', { question: String(message).slice(0, 240) });

  const prefix = contextSummary ? `Contexto operacional Argus:\n${contextSummary}\n\nPregunta del operador:` : '';
  const augmented = prefix ? `${prefix} ${message}` : message;

  const result = await chat({
    message: augmented,
    agentSlug: FALLBACK_AGENT,
    routerSlug: FALLBACK_ROUTER || undefined,
    threadId,
    externalThreadId: externalThreadId || (caseId ? `argus-${caseId}` : undefined),
  });

  if (!result.ok) {
    if (caseId) {
      await emit(db, caseId, 'struere', 'error', {
        provider: 'struere',
        agent: FALLBACK_AGENT,
        error: result.error,
      });
    }
    return NextResponse.json({
      ok: false,
      provider: 'struere',
      agentSlug: FALLBACK_AGENT,
      error: result.error,
      hint:
        result.error?.includes('Agent not found')
          ? `Deploy an agent with slug "${FALLBACK_AGENT}" via the Struere CLI ` +
            `(or set STRUERE_AGENT_SLUG / STRUERE_ROUTER_SLUG in .env.local).`
          : undefined,
    }, { status: 502 });
  }

  if (caseId) {
    await emit(db, caseId, 'struere', 'complete', {
      provider: 'struere',
      agent: FALLBACK_AGENT,
      threadId: result.threadId,
      tokens: { in: result.tokensIn || 0, out: result.tokensOut || 0 },
      excerpt: (result.reply || '').slice(0, 180),
    });
  }

  return NextResponse.json({
    ok: true,
    provider: 'struere',
    agentSlug: FALLBACK_AGENT,
    reply: result.reply,
    threadId: result.threadId,
    tokens: { in: result.tokensIn || 0, out: result.tokensOut || 0 },
  });
}
