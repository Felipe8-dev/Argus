import { createClient, SupabaseClient } from '@supabase/supabase-js';

export function getSupa(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function emit(
  db: SupabaseClient | null,
  caseId: string,
  agent: string,
  event: 'start' | 'progress' | 'complete' | 'error',
  payload: Record<string, any> = {},
) {
  if (!db || !caseId) return;
  try {
    await db.from('pipeline_events').insert({ case_id: caseId, agent, event, payload });
  } catch (err) {
    console.error('[emit] failed', (err as Error).message);
  }
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
