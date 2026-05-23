'use client';

import { useEffect, useState } from 'react';

export type OverlayKey = 'firms' | 'usgs' | 'gdacs';

export interface OverlayState {
  firms: boolean;
  usgs: boolean;
  gdacs: boolean;
}

interface Props {
  state: OverlayState;
  onChange: (s: OverlayState) => void;
  firmsConfigured: boolean;
}

const LABELS: Record<OverlayKey, { icon: string; label: string; hint: string }> = {
  firms: { icon: '🔥', label: 'Incendios', hint: 'NASA FIRMS · VIIRS NRT' },
  usgs: { icon: '🌍', label: 'Sismos', hint: 'USGS significant week' },
  gdacs: { icon: '⚠️', label: 'Desastres', hint: 'GDACS alert feed' },
};

export default function MapOverlayToggle({ state, onChange, firmsConfigured }: Props) {
  const toggle = (key: OverlayKey) => {
    if (key === 'firms' && !firmsConfigured) return;
    onChange({ ...state, [key]: !state[key] });
  };

  return (
    <div className="overlay-toggle">
      <span className="overlay-kicker">capas externas</span>
      {(Object.keys(LABELS) as OverlayKey[]).map((key) => {
        const disabled = key === 'firms' && !firmsConfigured;
        return (
          <button
            key={key}
            type="button"
            className={`overlay-chip ${state[key] ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
            onClick={() => toggle(key)}
            title={disabled ? 'Configura NASA_FIRMS_MAP_KEY' : LABELS[key].hint}
            disabled={disabled}
          >
            <span>{LABELS[key].icon}</span>
            <span>{LABELS[key].label}</span>
          </button>
        );
      })}
    </div>
  );
}
