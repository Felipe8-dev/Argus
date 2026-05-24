'use client';
import { createClient } from '@supabase/supabase-js';

// Fall back to the Supabase-Vercel-integration prefixed names so the browser
// still gets its keys when only the `argus_`-prefixed vars exist. Statically
// referenced so Next inlines them at build time.
const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_argus_SUPABASE_URL ||
  '';
const key =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_argus_SUPABASE_ANON_KEY ||
  '';

export const supabase = url && key ? createClient(url, key) : null;
