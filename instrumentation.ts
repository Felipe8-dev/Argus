/**
 * Next.js auto-loaded instrumentation hook.
 * Activa el módulo de trazas en cold-start del runtime de Node.
 * El trace buffer in-memory siempre está disponible; el export OTLP
 * a Logfire solo dispara si LOGFIRE_WRITE_TOKEN está configurada.
 */
/**
 * Bridge the Supabase Vercel integration's prefixed env vars to the names the
 * code expects. The integration creates `argus_SUPABASE_URL`,
 * `argus_SUPABASE_SERVICE_ROLE_KEY`, etc.; Argus reads the unprefixed names.
 * Here (server cold-start) we copy every `argus_*` / `NEXT_PUBLIC_argus_*`
 * value onto its unprefixed counterpart when that isn't already set.
 * NOTE: this only fixes SERVER-side reads — `NEXT_PUBLIC_*` used in the browser
 * is inlined at build time and must exist with the right name in Vercel.
 */
function normalizeEnv() {
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (k.startsWith('NEXT_PUBLIC_argus_')) {
      const bare = 'NEXT_PUBLIC_' + k.slice('NEXT_PUBLIC_argus_'.length);
      if (!process.env[bare]) process.env[bare] = v;
    } else if (k.startsWith('argus_')) {
      const bare = k.slice('argus_'.length);
      if (!process.env[bare]) process.env[bare] = v;
    }
  }
}

export async function register() {
  normalizeEnv();
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('@/lib/trace');
    if (process.env.LOGFIRE_WRITE_TOKEN) {
      console.log('[argus] Logfire OTLP export activo');
    } else {
      console.log('[argus] traces solo en buffer local (sin LOGFIRE_WRITE_TOKEN)');
    }
  }
}
