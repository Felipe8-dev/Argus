'use client';

import { useState } from 'react';

/**
 * Tiny floating legend para el heatmap de coincidencias visuales.
 * Refleja el gradient real usado en MapView (rgba(15,118,110)→rojo).
 * Collapsable para no robar foco visual.
 */
export default function HeatmapLegend() {
  const [open, setOpen] = useState(true);

  return (
    <div className={`heatmap-legend ${open ? 'open' : 'closed'}`}>
      <button className="heatmap-legend-toggle" onClick={() => setOpen((o) => !o)} title="Mostrar/ocultar leyenda">
        {open ? '×' : '▤'}
      </button>
      {open && (
        <>
          <div className="heatmap-legend-title">intensidad de coincidencias</div>
          <div className="heatmap-legend-bar" />
          <div className="heatmap-legend-ticks">
            <span>baja</span>
            <span>media</span>
            <span>alta</span>
            <span>crítica</span>
          </div>
        </>
      )}
    </div>
  );
}
