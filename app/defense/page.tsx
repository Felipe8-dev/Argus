'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import './defense.css';
import TracePanel from '@/app/components/TracePanel';
import SentinelPatternMap from '@/app/components/SentinelPatternMap';

interface Posture {
  cases: { total: number; last_24h: number; last_7d: number; by_status: Record<string, number> };
  agents: Record<string, { active: number; completed: number; error: number }>;
  intel: {
    provenance: { verified: number; suspect: number; unknown: number };
    gdelt_articles: number;
    overpass_pois: number;
  };
  sentinel: {
    cluster_alerts: number;
    trafficking_patterns: number;
    integrity_warnings: number;
    latest_patterns: any[];
  };
  struere: null | {
    configured: boolean;
    ok?: boolean;
    health?: { status: string; timestamp: number } | null;
    counts?: { agents: number; routers: number; tools: number; triggers: number; entityTypes: number } | null;
    error?: string;
  };
  last_events: Array<{ agent: string; event: string; status?: string; severity?: number; at: string }>;
}

function formatRelative(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60_000) return 'ahora';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h`;
  return `${Math.floor(diffMs / 86_400_000)}d`;
}

export default function DefensePosturePage() {
  const [posture, setPosture] = useState<Posture | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/intel/posture', { cache: 'no-store' });
        const data = await res.json();
        if (cancelled) return;
        if (data.ok) {
          setPosture(data.posture);
          setGeneratedAt(data.generated_at);
          setError(null);
        } else {
          setError(data.error || 'snapshot unavailable');
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'network');
      }
    }
    load();
    const id = window.setInterval(load, 4000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  const agentRows = useMemo(() => {
    if (!posture) return [];
    return Object.entries(posture.agents).sort((a, b) => {
      const aTotal = a[1].active + a[1].completed + a[1].error;
      const bTotal = b[1].active + b[1].completed + b[1].error;
      return bTotal - aTotal;
    });
  }, [posture]);

  const integrityPct = useMemo(() => {
    if (!posture) return null;
    const v = posture.intel.provenance.verified;
    const s = posture.intel.provenance.suspect;
    const u = posture.intel.provenance.unknown;
    const total = v + s + u;
    if (!total) return null;
    return Math.round((v / total) * 100);
  }, [posture]);

  return (
    <main className="defense-shell">
      <header className="dp-topbar">
        <div className="dp-brand">
          <div className="dp-brand-kicker">ARGUS · def/acc operations</div>
          <h1>Defense Posture <small>v0.1</small></h1>
          <p>
            Centro de mando para coordinar respuesta civil temprana. Snapshot vivo cada 4 segundos
            sobre casos activos, agentes desplegados y señales de amenaza correlacionadas.
          </p>
        </div>
        <nav className="dp-nav">
          <Link href="/">Operaciones</Link>
          <Link href="/dashboard">Dashboard</Link>
        </nav>
      </header>

      {error && <div className="dp-error">Snapshot no disponible: {error}</div>}

      <section className="dp-kpis">
        <KPI
          index="/01"
          label="Casos · 24h"
          value={posture?.cases.last_24h ?? '—'}
          hint={`${posture?.cases.last_7d ?? '—'} en 7 días`}
          tone="ok"
        />
        <KPI
          index="/02"
          label="Patrones de trata"
          value={posture?.sentinel.trafficking_patterns ?? '—'}
          hint={`${posture?.sentinel.cluster_alerts ?? 0} clusters detectados`}
          tone={posture && posture.sentinel.trafficking_patterns ? 'alert' : 'neutral'}
        />
        <KPI
          index="/03"
          label="Deepfakes filtrados"
          value={posture?.intel.provenance.suspect ?? '—'}
          hint={`${integrityPct ?? '—'}% portraits verificados`}
          tone={posture && posture.intel.provenance.suspect ? 'warn' : 'ok'}
        />
        <KPI
          index="/04"
          label="OSINT correlacionado"
          value={posture?.intel.gdelt_articles ?? '—'}
          hint="artículos GDELT geo-enlazados"
          tone="neutral"
        />
        <KPI
          index="/05"
          label="Infra crítica"
          value={posture?.intel.overpass_pois ?? '—'}
          hint="policía · salud · refugios · tránsito"
          tone="neutral"
        />
        <KPI
          index="/06"
          label="Integridad"
          value={posture?.sentinel.integrity_warnings ?? '—'}
          hint="reportes en revisión"
          tone={posture && posture.sentinel.integrity_warnings ? 'warn' : 'ok'}
        />
      </section>

      <section className="dp-grid">
        <article className="dp-card">
          <header className="dp-card-head">
            <span className="dp-card-kicker">/07  Agentes desplegados</span>
            <h3>Throughput del pipeline · últimos 7 días</h3>
          </header>
          {agentRows.length === 0 ? (
            <p className="dp-muted">Sin actividad reciente. Inicia un caso desde Operaciones.</p>
          ) : (
            <ul className="dp-agent-list">
              {agentRows.map(([agent, stats]) => {
                const total = stats.active + stats.completed + stats.error;
                const pctCompleted = total ? Math.round((stats.completed / total) * 100) : 0;
                return (
                  <li key={agent}>
                    <strong>{agent}</strong>
                    <em>{total} ev</em>
                    <div className="dp-agent-bar"><span style={{ width: `${pctCompleted}%` }} /></div>
                    <div className="dp-agent-meta">
                      <span>activo {stats.active}</span>
                      <span>ok {stats.completed}</span>
                      {stats.error > 0 && <span className="bad">err {stats.error}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </article>

        <article className="dp-card">
          <header className="dp-card-head">
            <span className="dp-card-kicker">/08  Sentinel · patrones</span>
            <h3>Señales de trata · warnings de integridad</h3>
          </header>
          {posture && posture.sentinel.latest_patterns.length > 0 ? (
            <ul className="dp-pattern-list">
              {posture.sentinel.latest_patterns.map((p, i) => (
                <li key={i}>
                  <div className="dp-pattern-tag">PATRÓN {(p.cases || 0)}× · {p.gender || '—'}/{p.age_band || '—'}</div>
                  <div className="dp-pattern-meta">
                    {p.zone?.label || 'Zona priorizada'}
                    {p.at && <span> · {formatRelative(p.at)} atrás</span>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="dp-muted">Sin patrones de trata detectados. Sentinel sigue barriendo en background.</p>
          )}
        </article>

        <article className="dp-card">
          <header className="dp-card-head">
            <span className="dp-card-kicker">/09  Struere runtime</span>
            <h3>{posture?.struere?.configured ? 'Co-piloto enlazado' : 'Sin configurar'}</h3>
          </header>
          {!posture?.struere?.configured ? (
            <p className="dp-muted">
              Define <code>STRUERE_API_KEY</code> y deploya un agente con slug <code>argus-ops</code> para activar el co-piloto del operador.
            </p>
          ) : (
            <ul className="dp-struere">
              <li><span>health</span><strong>{posture.struere.health?.status || (posture.struere.ok ? 'ok' : 'down')}</strong></li>
              <li><span>agents</span><strong>{posture.struere.counts?.agents ?? '—'}</strong></li>
              <li><span>routers</span><strong>{posture.struere.counts?.routers ?? '—'}</strong></li>
              <li><span>tools</span><strong>{posture.struere.counts?.tools ?? '—'}</strong></li>
              <li><span>triggers</span><strong>{posture.struere.counts?.triggers ?? '—'}</strong></li>
              <li><span>entity types</span><strong>{posture.struere.counts?.entityTypes ?? '—'}</strong></li>
              {posture.struere.error && (
                <li className="bad"><span>error</span><strong>{posture.struere.error.slice(0, 60)}</strong></li>
              )}
              {posture.struere.counts?.agents === 0 && (
                <li className="hint">
                  Deploya un agente y setea <code>STRUERE_AGENT_SLUG</code> para activar el co-pilot.
                </li>
              )}
            </ul>
          )}
        </article>

        <article className="dp-card dp-card-wide">
          <header className="dp-card-head">
            <span className="dp-card-kicker">/12  Sentinel · geo-clusters</span>
            <h3>Patrones de trata mapeados</h3>
          </header>
          <SentinelPatternMap patterns={posture?.sentinel.latest_patterns || []} />
        </article>

        <TracePanel />

        <article className="dp-card dp-card-wide">
          <header className="dp-card-head">
            <span className="dp-card-kicker">/10  Telemetría</span>
            <h3>Eventos crudos del pipeline · últimos 12</h3>
          </header>
          {!posture || posture.last_events.length === 0 ? (
            <p className="dp-muted">Sin eventos recientes.</p>
          ) : (
            <ul className="dp-feed">
              {posture.last_events.map((event, i) => (
                <li key={i} className={`tone-${event.event}`}>
                  <time>{formatRelative(event.at)} atrás</time>
                  <strong>{event.agent}</strong>
                  <span>{event.status || event.event}</span>
                  {Number.isFinite(event.severity) ? (
                    <em>sev {Math.round((event.severity as number) * 100)}</em>
                  ) : (
                    <em>&nbsp;</em>
                  )}
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      <footer className="dp-footer">
        {generatedAt ? <>snapshot <span>{formatRelative(generatedAt)}</span> atrás · poll 4s</> : 'cargando snapshot…'}
      </footer>
    </main>
  );
}

function KPI({
  index,
  label,
  value,
  hint,
  tone,
}: {
  index: string;
  label: string;
  value: number | string;
  hint?: string;
  tone: 'ok' | 'warn' | 'alert' | 'neutral';
}) {
  return (
    <div className="dp-kpi" data-tone={tone}>
      <span className="dp-kpi-label" data-index={index}>{label}</span>
      <strong className="dp-kpi-value">{value}</strong>
      {hint && <span className="dp-kpi-hint">{hint}</span>}
    </div>
  );
}
