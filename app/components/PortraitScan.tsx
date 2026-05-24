'use client';
// PortraitScan — the "analyzing" popup shown when the family uploads the
// portrait in the intake. Runs face-api over the image and draws the 68
// facial-landmark points with a scanning sweep (the OpenCV-style effect),
// then reports the face as verified. Visual only; no matching here.
import { useEffect, useRef, useState, useCallback } from 'react';
import { loadModels, describeAllFaces, type DetectedFace } from '@/lib/face/faceapi';

interface Props {
  /** Image to scan — a blob:/data: URL (same-origin, canvas-safe) or http URL. */
  src: string;
  /** Called when the operator closes the popup. */
  onClose: () => void;
}

type Phase = 'loading' | 'scanning' | 'done' | 'noface' | 'error';

export default function PortraitScan({ src, onClose }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const facesRef = useRef<DetectedFace[]>([]);
  const rafRef = useRef<number>(0);

  const [phase, setPhase] = useState<Phase>('loading');
  const [status, setStatus] = useState('Cargando visión…');

  const draw = useCallback((reveal: number, sweep: number | null, natW: number, natH: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const sx = canvas.width / natW;
    const sy = canvas.height / natH;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const f of facesRef.current) {
      // face box
      ctx.strokeStyle = phase === 'done' ? '#39ff14' : 'rgba(0,229,255,0.7)';
      ctx.lineWidth = 2;
      ctx.strokeRect(f.x * sx, f.y * sy, f.width * sx, f.height * sy);
      // landmark points, revealed top→down by the sweep
      ctx.fillStyle = phase === 'done' ? '#39ff14' : '#00e5ff';
      for (const p of f.landmarks) {
        const py = p.y * sy;
        if (py > canvas.height * reveal) continue;
        ctx.beginPath();
        ctx.arc(p.x * sx, py, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (sweep != null) {
      const y = sweep * canvas.height;
      const g = ctx.createLinearGradient(0, y - 26, 0, y + 4);
      g.addColorStop(0, 'rgba(0,229,255,0)');
      g.addColorStop(1, 'rgba(0,229,255,0.5)');
      ctx.fillStyle = g;
      ctx.fillRect(0, y - 26, canvas.width, 30);
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }
  }, [phase]);

  const run = useCallback(async () => {
    const img = imgRef.current;
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!img || !wrap || !canvas) return;
    const natW = img.naturalWidth || 1;
    const natH = img.naturalHeight || 1;
    const rect = wrap.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    try {
      setStatus('Analizando biometría facial…');
      setPhase('scanning');
      await loadModels();
      facesRef.current = await describeAllFaces(img);

      // sweep animation top→down revealing the landmark points
      const start = performance.now();
      const DUR = 2200;
      await new Promise<void>((resolve) => {
        const step = (t: number) => {
          const r = Math.min(1, (t - start) / DUR);
          draw(r, r, natW, natH);
          if (r < 1) rafRef.current = requestAnimationFrame(step);
          else resolve();
        };
        rafRef.current = requestAnimationFrame(step);
      });

      if (facesRef.current.length) {
        setPhase('done');
        setStatus('Rostro verificado · listo para la búsqueda');
        draw(1, null, natW, natH);
      } else {
        setPhase('noface');
        setStatus('No se detectó un rostro claro — se usará igual como referencia.');
      }
    } catch (err: any) {
      setPhase('error');
      setStatus(`Visión no disponible: ${(err?.message || '').slice(0, 60)}`);
    }
  }, [draw]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // auto-close shortly after a successful scan so the intake keeps flowing
  useEffect(() => {
    if (phase === 'done' || phase === 'noface') {
      const id = setTimeout(onClose, 2600);
      return () => clearTimeout(id);
    }
  }, [phase, onClose]);

  const accent = phase === 'done' ? '#39ff14' : phase === 'error' ? '#ff6b6b' : '#00e5ff';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 80, display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: 'rgba(2,5,12,0.82)', backdropFilter: 'blur(6px)',
      }}
    >
      <style>{`@keyframes psp{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(420px, 92vw)', borderRadius: 14, overflow: 'hidden',
          background: '#05070d', border: `1px solid ${accent}55`, boxShadow: `0 0 40px ${accent}22`,
        }}
      >
        <div style={{ padding: '12px 14px', font: '600 12px ui-monospace,monospace', letterSpacing: '.05em', color: accent, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent, animation: 'psp 1.1s infinite' }} />
          ANÁLISIS FACIAL · ARGUS
        </div>
        <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
          <img
            ref={imgRef}
            src={src}
            alt="retrato"
            crossOrigin="anonymous"
            onLoad={run}
            style={{ display: 'block', width: '100%', height: 'auto' }}
          />
          <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
        </div>
        <div style={{ padding: '10px 14px 14px', font: '12px ui-monospace,monospace', color: accent }}>
          {status}
        </div>
      </div>
    </div>
  );
}
