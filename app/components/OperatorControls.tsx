'use client';

interface Props {
  radiusKm: number;
  onRadiusChange: (v: number) => void;
  minConfidence: number;
  onConfidenceChange: (v: number) => void;
  pinMode: boolean;
  onTogglePin: () => void;
}

/**
 * Controles del operador embebidos en el case widget:
 *  · Slider radio de búsqueda (0.5–10 km) — modifica los rings del mapa
 *  · Slider confianza mínima — filtra matches visibles
 *  · Toggle "marcar avistamiento" — activa pin mode en el mapa
 */
export default function OperatorControls({
  radiusKm, onRadiusChange,
  minConfidence, onConfidenceChange,
  pinMode, onTogglePin,
}: Props) {
  return (
    <div className="op-controls">
      <div className="op-control">
        <div className="op-control-head">
          <span>radio de búsqueda</span>
          <strong>{radiusKm.toFixed(1)} km</strong>
        </div>
        <input
          type="range" min="0.5" max="10" step="0.1"
          value={radiusKm}
          onChange={(e) => onRadiusChange(parseFloat(e.target.value))}
          className="op-slider op-slider--amber"
        />
      </div>

      <div className="op-control">
        <div className="op-control-head">
          <span>confianza mínima</span>
          <strong>{Math.round(minConfidence * 100)}%</strong>
        </div>
        <input
          type="range" min="0" max="1" step="0.05"
          value={minConfidence}
          onChange={(e) => onConfidenceChange(parseFloat(e.target.value))}
          className="op-slider op-slider--jade"
        />
      </div>

      <button
        type="button"
        className={`op-pin-btn ${pinMode ? 'active' : ''}`}
        onClick={onTogglePin}
      >
        {pinMode ? '✕ cancelar pin' : '📍 marcar avistamiento'}
      </button>
    </div>
  );
}
