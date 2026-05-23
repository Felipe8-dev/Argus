'use client';

import { useState } from 'react';

const THREATS = [
  {
    icon: '🕵️',
    title: 'Desapariciones y trata coordinada',
    detail: 'Sentinel detecta patrones (≥3 casos, ≤5km, mismo género y rango etario, 7 días)',
  },
  {
    icon: '🎭',
    title: 'Deepfakes de portraits',
    detail: 'EXIF + hash perceptual + manifiesto C2PA + Gemini Vision clasificador',
  },
  {
    icon: '⚠️',
    title: 'Falso-reporte fraudulento',
    detail: 'Sentinel integrity warnings (mismo teléfono con ≥2 casos en 24h)',
  },
  {
    icon: '🚨',
    title: 'Fallos de ruteo de emergencia',
    detail: 'OSM Overpass mapea policía, hospital y refugio en radio de 4 km',
  },
  {
    icon: '📢',
    title: 'Desinformación viral',
    detail: 'Provenance firmada en cada publicación + anclaje Filecoin/IPFS',
  },
];

export default function ThreatModelCard() {
  const [open, setOpen] = useState(false);

  return (
    <div className="tm-card">
      <div className="tm-head">
        <span className="tm-kicker">def/acc · threat model</span>
        <button className="tm-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? 'ocultar' : `ver los 5 (${THREATS.length})`}
        </button>
      </div>
      <h2 className="tm-title">Contra qué defiende Argus</h2>
      {!open && (
        <div className="tm-pills">
          {THREATS.map((t) => (
            <span key={t.title} className="tm-pill" title={t.detail}>
              <span>{t.icon}</span>
              <span>{t.title}</span>
            </span>
          ))}
        </div>
      )}
      {open && (
        <ul className="tm-list">
          {THREATS.map((t) => (
            <li key={t.title}>
              <div className="tm-list-icon">{t.icon}</div>
              <div>
                <strong>{t.title}</strong>
                <p>{t.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
