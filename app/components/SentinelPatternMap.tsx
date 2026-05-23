'use client';

import { useMemo } from 'react';

interface Pattern {
  cases?: number;
  gender?: string;
  age_band?: string;
  zone?: { label?: string; lat?: number; lng?: number };
  at?: string;
}

interface Props {
  patterns: Pattern[];
}

/**
 * Mini-grafo SVG de patrones de Sentinel.
 * No usa Mapbox para mantener /defense ligero — es un canvas
 * abstracto donde el eje X = longitud relativa, Y = latitud relativa,
 * radio del círculo = cantidad de casos, color por género.
 */
export default function SentinelPatternMap({ patterns }: Props) {
  const points = useMemo(() => {
    const valid = patterns
      .map((p) => ({
        cases: p.cases || 1,
        gender: (p.gender || '?').toLowerCase(),
        age: p.age_band || '?',
        label: p.zone?.label || 'zona priorizada',
        at: p.at,
        lat: p.zone?.lat,
        lng: p.zone?.lng,
      }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (!valid.length) return [];
    const lats = valid.map((p) => p.lat as number);
    const lngs = valid.map((p) => p.lng as number);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const dLat = Math.max(0.001, maxLat - minLat);
    const dLng = Math.max(0.001, maxLng - minLng);
    return valid.map((p) => ({
      ...p,
      x: ((p.lng as number) - minLng) / dLng,
      y: 1 - ((p.lat as number) - minLat) / dLat,
    }));
  }, [patterns]);

  if (!patterns.length) {
    return <p className="dp-muted">Sin patrones geo-correlacionados. Sentinel sigue barriendo.</p>;
  }

  if (!points.length) {
    return <p className="dp-muted">Patrones detectados pero sin coordenadas para graficar.</p>;
  }

  const W = 360;
  const H = 200;
  const pad = 20;

  return (
    <div className="spm-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="spm-svg" preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id="spm-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(229, 87, 58, 0.55)" />
            <stop offset="100%" stopColor="rgba(229, 87, 58, 0)" />
          </radialGradient>
        </defs>
        <rect width={W} height={H} fill="rgba(255,255,255,0.02)" rx="4" />
        {/* gridlines */}
        {[0.25, 0.5, 0.75].map((t) => (
          <g key={t} opacity={0.18}>
            <line x1={pad + t * (W - 2 * pad)} y1={pad} x2={pad + t * (W - 2 * pad)} y2={H - pad} stroke="rgba(255,255,255,0.5)" strokeWidth="0.4" />
            <line x1={pad} y1={pad + t * (H - 2 * pad)} x2={W - pad} y2={pad + t * (H - 2 * pad)} stroke="rgba(255,255,255,0.5)" strokeWidth="0.4" />
          </g>
        ))}
        {points.map((p, i) => {
          const cx = pad + p.x * (W - 2 * pad);
          const cy = pad + p.y * (H - 2 * pad);
          const r = 6 + Math.min(20, p.cases * 3);
          const colorByGender = p.gender === 'femenino' ? '#ff5fa5' : p.gender === 'masculino' ? '#5fa5ff' : '#ffd166';
          return (
            <g key={i}>
              <circle cx={cx} cy={cy} r={r * 1.8} fill="url(#spm-glow)" />
              <circle cx={cx} cy={cy} r={r} fill={colorByGender} fillOpacity="0.78" stroke="#fff" strokeOpacity="0.4" strokeWidth="1.2" />
              <text x={cx} y={cy + 3} textAnchor="middle" fontSize="9" fontFamily="monospace" fill="#0a1414" fontWeight="700">{p.cases}</text>
              <text x={cx} y={cy + r + 12} textAnchor="middle" fontSize="8" fontFamily="monospace" fill="rgba(255,255,255,0.7)">{p.label.slice(0, 18)}</text>
            </g>
          );
        })}
      </svg>
      <div className="spm-legend">
        <span><i style={{ background: '#ff5fa5' }} /> femenino</span>
        <span><i style={{ background: '#5fa5ff' }} /> masculino</span>
        <span><i style={{ background: '#ffd166' }} /> otro/?</span>
        <span className="spm-hint">tamaño = cantidad de casos</span>
      </div>
    </div>
  );
}
