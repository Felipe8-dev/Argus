import { NextResponse } from 'next/server';
import { health, isConfigured, syncState } from '@/lib/struere';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Returns the live sync snapshot of the operator's Struere account
 * (agents, routers, tools, triggers, entity types). Used by the Defense
 * Posture panel to *prove* the platform integration is real even when
 * the operator hasn't deployed any agents yet.
 */
export async function GET() {
  if (!isConfigured()) {
    return NextResponse.json({
      ok: false,
      configured: false,
      error: 'STRUERE_API_KEY not configured',
    });
  }

  const [healthRes, stateRes] = await Promise.all([health(), syncState()]);

  return NextResponse.json({
    ok: stateRes.ok,
    configured: true,
    health: healthRes.data,
    state: stateRes.data,
    error: stateRes.error,
    counts: stateRes.data
      ? {
          agents: stateRes.data.agents?.length || 0,
          routers: stateRes.data.routers?.length || 0,
          tools: stateRes.data.tools?.length || 0,
          triggers: stateRes.data.triggers?.length || 0,
          entityTypes: stateRes.data.entityTypes?.length || 0,
        }
      : null,
  });
}
