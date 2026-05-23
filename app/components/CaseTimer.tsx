'use client';

import { useEffect, useState } from 'react';

interface Props {
  caseId: string | null;
  startAt?: string | null;
  firstMatchAt?: string | null;
}

function fmt(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * Visceral timer: cuenta desde que el caso arranca, congela en jade
 * cuando llega la primera coincidencia. Patrón "tiempo a primer match"
 * que los jurados no técnicos sienten directo.
 */
export default function CaseTimer({ caseId, startAt, firstMatchAt }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (firstMatchAt) return; // freeze
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [firstMatchAt]);

  if (!caseId || !startAt) {
    return (
      <div className="case-timer case-timer--idle">
        <span className="case-timer-label">tiempo activo</span>
        <strong className="case-timer-value">— : —</strong>
      </div>
    );
  }

  const startMs = new Date(startAt).getTime();
  const matched = !!firstMatchAt;
  const elapsed = matched
    ? new Date(firstMatchAt).getTime() - startMs
    : now - startMs;

  return (
    <div className={`case-timer ${matched ? 'case-timer--match' : 'case-timer--live'}`}>
      <span className="case-timer-label">
        {matched ? '✓ primera coincidencia en' : 'tiempo activo'}
      </span>
      <strong className="case-timer-value">{fmt(elapsed)}</strong>
    </div>
  );
}
