'use client';

import { useEffect, useState } from 'react';

interface Span {
  span_id: string;
  trace_id: string;
  parent_span_id?: string;
  name: string;
  started_at: number;
  ended_at?: number;
  duration_ms?: number;
  status: 'ok' | 'error' | 'in_progress';
  attrs: Record<string, any>;
  error?: { message?: string };
}

function ago(ms: number) {
  const d = Date.now() - ms;
  if (d < 1000) return `${d}ms`;
  if (d < 60_000) return `${Math.floor(d / 1000)}s`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  return `${Math.floor(d / 3_600_000)}h`;
}

export default function TracePanel() {
  const [spans, setSpans] = useState<Span[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await fetch('/api/trace/recent?limit=40', { cache: 'no-store' });
        const json = await r.json();
        if (!cancelled) {
          setSpans(json.spans || []);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'network');
      }
    }
    tick();
    const id = window.setInterval(tick, 2500);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  return (
    <article className="dp-card dp-card-wide">
      <header className="dp-card-head">
        <span className="dp-card-kicker">/11  trazabilidad · supervisión humana</span>
        <h3>Cada decisión de cada agente · últimos {spans.length} spans</h3>
      </header>
      {error && <p className="dp-muted">Sin telemetría: {error}</p>}
      {spans.length === 0 ? (
        <p className="dp-muted">Sin spans aún. Inicia un caso para ver el árbol de decisiones.</p>
      ) : (
        <ul className="trace-list">
          {spans.map((s) => (
            <li key={s.span_id} className={`trace-row trace-${s.status} ${openId === s.span_id ? 'open' : ''}`}>
              <button className="trace-row-head" onClick={() => setOpenId(openId === s.span_id ? null : s.span_id)}>
                <time>{ago(s.started_at)}</time>
                <strong>{s.name}</strong>
                <em>{s.duration_ms !== undefined ? `${s.duration_ms}ms` : 'live'}</em>
                <span className={`trace-status trace-status-${s.status}`}>
                  {s.status === 'ok' ? '✓' : s.status === 'error' ? '✗' : '…'}
                </span>
              </button>
              {openId === s.span_id && (
                <div className="trace-row-body">
                  <pre>{JSON.stringify(s.attrs, null, 2)}</pre>
                  {s.error && <pre className="trace-err">{s.error.message}</pre>}
                  <div className="trace-meta">
                    <span>trace {s.trace_id.slice(0, 12)}…</span>
                    {s.parent_span_id && <span>parent {s.parent_span_id.slice(0, 8)}…</span>}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {process.env.NEXT_PUBLIC_LOGFIRE_PROJECT_URL && (
        <footer className="trace-foot">
          <a href={process.env.NEXT_PUBLIC_LOGFIRE_PROJECT_URL} target="_blank" rel="noreferrer">
            Exportar a Logfire →
          </a>
        </footer>
      )}
    </article>
  );
}
