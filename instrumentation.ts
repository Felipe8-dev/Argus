/**
 * Next.js auto-loaded instrumentation hook.
 * Activa el módulo de trazas en cold-start del runtime de Node.
 * El trace buffer in-memory siempre está disponible; el export OTLP
 * a Logfire solo dispara si LOGFIRE_WRITE_TOKEN está configurada.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('@/lib/trace');
    if (process.env.LOGFIRE_WRITE_TOKEN) {
      console.log('[argus] Logfire OTLP export activo');
    } else {
      console.log('[argus] traces solo en buffer local (sin LOGFIRE_WRITE_TOKEN)');
    }
  }
}
