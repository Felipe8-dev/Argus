'use client';

import { useMemo } from 'react';
import type { OverlayState, OverlayKey } from './MapOverlayToggle';

interface FC {
  type: 'FeatureCollection';
  features: any[];
}

interface Props {
  firms?: FC | null;
  usgs?: FC | null;
  gdacs?: FC | null;
  caseCenter?: { lat: number; lng: number } | null;
  state: OverlayState;
  onToggle: (key: OverlayKey) => void;
  firmsConfigured: boolean;
}

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function nearestFeature(fc: FC | null | undefined, center: [number, number]): { f: any; km: number } | null {
  if (!fc || !fc.features.length) return null;
  let best: { f: any; km: number } | null = null;
  for (const f of fc.features) {
    const c = f?.geometry?.coordinates;
    if (!Array.isArray(c) || c.length < 2) continue;
    const km = haversineKm(center, [c[0], c[1]]);
    if (!best || km < best.km) best = { f, km };
  }
  return best;
}

export default function ExternalSignalRail({
  firms, usgs, gdacs, caseCenter, state, onToggle, firmsConfigured,
}: Props) {
  const center: [number, number] | null = caseCenter ? [caseCenter.lng, caseCenter.lat] : null;

  const firmsInfo = useMemo(() => {
    if (!firmsConfigured) return { count: 0, label: 'configurar NASA' };
    if (!firms) return { count: 0, label: 'cargando…' };
    const total = firms.features.length;
    if (!total) return { count: 0, label: 'sin focos cerca' };
    if (!center) return { count: total, label: `${total} hotspots` };
    const near = nearestFeature(firms, center);
    return { count: total, label: `${total} · más cerca ${Math.round(near?.km || 0)}km` };
  }, [firms, center, firmsConfigured]);

  const usgsInfo = useMemo(() => {
    if (!usgs) return { count: 0, label: 'cargando…' };
    const total = usgs.features.length;
    if (!total) return { count: 0, label: 'semana sin sismos M3+' };
    if (!center) return { count: total, label: `${total} sismos` };
    const near = nearestFeature(usgs, center);
    const mag = near?.f?.properties?.mag;
    return { count: total, label: `${total} · M${mag ?? '?'} a ${Math.round(near?.km || 0)}km` };
  }, [usgs, center]);

  const gdacsInfo = useMemo(() => {
    if (!gdacs) return { count: 0, label: 'cargando…' };
    const total = gdacs.features.length;
    if (!total) return { count: 0, label: 'sin alertas activas' };
    const reds = gdacs.features.filter((f) => f.properties?.alert_level === 'Red').length;
    const oranges = gdacs.features.filter((f) => f.properties?.alert_level === 'Orange').length;
    const tag = reds > 0 ? `🔴 ${reds} rojas` : oranges > 0 ? `🟠 ${oranges} naranjas` : `${total} verdes`;
    return { count: total, label: tag };
  }, [gdacs]);

  const Chip = ({ k, icon, dot, info }: { k: OverlayKey; icon: string; dot: string; info: { count: number; label: string } }) => {
    const disabled = k === 'firms' && !firmsConfigured;
    const active = state[k] && !disabled;
    return (
      <button
        type="button"
        className={`signal-chip ${active ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && onToggle(k)}
        title={disabled ? 'Configura NASA_FIRMS_MAP_KEY' : `Click para ${active ? 'ocultar' : 'mostrar'} en el mapa`}
        disabled={disabled}
      >
        <span className={`signal-dot signal-dot--${dot}`} />
        <span className="signal-chip-icon">{icon}</span>
        <span>{info.label}</span>
      </button>
    );
  };

  return (
    <div className="signal-rail">
      <span className="signal-rail-kicker">señales globales · live</span>
      <div className="signal-rail-items">
        <Chip k="firms" icon="🔥" dot="fire" info={firmsInfo} />
        <Chip k="usgs" icon="🌍" dot="quake" info={usgsInfo} />
        <Chip k="gdacs" icon="⚠️" dot="alert" info={gdacsInfo} />
      </div>
    </div>
  );
}
