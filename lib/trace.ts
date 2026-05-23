/**
 * Trazabilidad de agentes — buffer rotante + OTLP opcional.
 *
 * El pilar def/acc "human stays in the loop / supervise systems" pide
 * que cada decisión del pipeline sea auditable en vivo. Este módulo
 * acumula spans en un buffer in-memory (últimos N) que el panel
 * /defense consume cada 2s, y opcionalmente los exporta vía OTLP a
 * Logfire / Honeycomb / Jaeger si hay LOGFIRE_WRITE_TOKEN.
 *
 * Sin token: el buffer local sigue funcionando — el panel muestra
 * todo, solo no se exporta. Esto evita acoplamiento a un SaaS.
 */

import crypto from 'crypto';

export type SpanStatus = 'ok' | 'error' | 'in_progress';

export interface SpanRecord {
  span_id: string;
  trace_id: string;
  parent_span_id?: string;
  name: string;
  started_at: number;
  ended_at?: number;
  duration_ms?: number;
  status: SpanStatus;
  attrs: Record<string, any>;
  error?: { message: string; stack?: string };
}

const BUFFER_CAPACITY = 500;
const buffer: SpanRecord[] = [];

function randomId(bytes = 8): string {
  return crypto.randomBytes(bytes).toString('hex');
}

function pushSpan(span: SpanRecord) {
  buffer.push(span);
  while (buffer.length > BUFFER_CAPACITY) buffer.shift();
  // Async OTLP export — fire & forget, never blocks.
  void exportSpanOTLP(span);
}

export function getRecentSpans(limit = 50): SpanRecord[] {
  return buffer.slice(-limit).reverse();
}

export function clearTraceBuffer() {
  buffer.length = 0;
}

const traceContext: { current?: { trace_id: string; span_id: string } } = {};

export interface SpanOptions {
  attrs?: Record<string, any>;
  parentSpanId?: string;
  traceId?: string;
}

export async function withSpan<T>(
  name: string,
  optsOrFn: SpanOptions | ((span: SpanRecord) => Promise<T> | T),
  maybeFn?: (span: SpanRecord) => Promise<T> | T,
): Promise<T> {
  const opts: SpanOptions = typeof optsOrFn === 'function' ? {} : optsOrFn;
  const fn = (typeof optsOrFn === 'function' ? optsOrFn : maybeFn) as (span: SpanRecord) => Promise<T> | T;
  if (typeof fn !== 'function') throw new Error('withSpan requires fn');

  const parent = traceContext.current;
  const trace_id = opts.traceId || parent?.trace_id || randomId(16);
  const span_id = randomId(8);
  const parent_span_id = opts.parentSpanId || parent?.span_id;

  const span: SpanRecord = {
    span_id,
    trace_id,
    parent_span_id,
    name,
    started_at: Date.now(),
    status: 'in_progress',
    attrs: { ...(opts.attrs || {}) },
  };

  const prev = traceContext.current;
  traceContext.current = { trace_id, span_id };

  try {
    const result = await fn(span);
    span.status = 'ok';
    span.ended_at = Date.now();
    span.duration_ms = span.ended_at - span.started_at;
    pushSpan(span);
    return result;
  } catch (err: any) {
    span.status = 'error';
    span.ended_at = Date.now();
    span.duration_ms = span.ended_at - span.started_at;
    span.error = { message: err?.message || String(err), stack: err?.stack?.split('\n').slice(0, 5).join('\n') };
    pushSpan(span);
    throw err;
  } finally {
    traceContext.current = prev;
  }
}

export function recordLLMCost(span: SpanRecord | null, model: string, inputTokens: number, outputTokens: number) {
  if (!span) return;
  span.attrs.llm_model = model;
  span.attrs.llm_input_tokens = inputTokens;
  span.attrs.llm_output_tokens = outputTokens;
}

export function annotate(span: SpanRecord, attrs: Record<string, any>) {
  Object.assign(span.attrs, attrs);
}

/**
 * Record a finished span without wrapping the function body.
 * Útil para instrumentar rutas existentes sin reestructurar el código:
 *
 *   const started = Date.now();
 *   try {
 *     // ... existing body ...
 *   } finally {
 *     recordSpan('agent.X.Y', { case_id }, started);
 *   }
 */
export function recordSpan(
  name: string,
  attrs: Record<string, any>,
  startedAt: number,
  status: SpanStatus = 'ok',
  errorMsg?: string,
) {
  const ended = Date.now();
  pushSpan({
    span_id: randomId(8),
    trace_id: randomId(16),
    name,
    started_at: startedAt,
    ended_at: ended,
    duration_ms: ended - startedAt,
    status,
    attrs,
    ...(errorMsg ? { error: { message: errorMsg } } : {}),
  });
}

/**
 * Export OTLP a Logfire si el token está configurado.
 * Logfire acepta el endpoint OTLP HTTP estándar.
 * Endpoint: https://logfire-api.pydantic.dev/v1/traces
 */
async function exportSpanOTLP(span: SpanRecord) {
  const token = process.env.LOGFIRE_WRITE_TOKEN;
  if (!token) return;

  const endpoint = process.env.OTLP_TRACES_ENDPOINT || 'https://logfire-api.pydantic.dev/v1/traces';

  const otlpSpan = {
    traceId: span.trace_id,
    spanId: span.span_id,
    parentSpanId: span.parent_span_id,
    name: span.name,
    kind: 1,
    startTimeUnixNano: String(span.started_at * 1_000_000),
    endTimeUnixNano: String((span.ended_at || span.started_at) * 1_000_000),
    attributes: Object.entries(span.attrs).map(([k, v]) => ({
      key: k,
      value: typeof v === 'string' ? { stringValue: v } : { stringValue: JSON.stringify(v) },
    })),
    status: { code: span.status === 'error' ? 2 : 1, message: span.error?.message || '' },
  };

  const body = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'argus-defacc' } },
            { key: 'service.version', value: { stringValue: '0.1.0' } },
          ],
        },
        scopeSpans: [{ scope: { name: 'argus' }, spans: [otlpSpan] }],
      },
    ],
  };

  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    if (process.env.TRACE_DEBUG) console.warn('[trace] OTLP export failed:', err?.message);
  }
}
