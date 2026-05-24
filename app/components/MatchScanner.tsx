'use client';
// MatchScanner — the CV "wow" layer.
//
// Given a match's media (a photo or video published on some random account)
// and the case portrait, it:
//   1. computes the target's 128-d face descriptor from the portrait,
//   2. detects every face in the media and draws the 68-point scan overlay
//      with an animated sweep line,
//   3. recognises which face is the missing person and locks a tracker box
//      onto them (green brackets + confidence). On video the box follows them.
//
// All client-side (@vladmandic/face-api). Media is loaded same-origin through
// /api/media-proxy so the canvas stays readable.
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  loadModels,
  describeFace,
  describeAllFaces,
  matchAgainst,
  type DetectedFace,
  type MatchResult,
} from '@/lib/face/faceapi';

type Phase = 'loading' | 'scanning' | 'matched' | 'nomatch' | 'tracking' | 'error';

interface Props {
  /** The match media — a post URL or a direct image/video URL. */
  mediaUrl: string;
  /** The missing person's portrait (target). */
  portraitUrl: string;
  /** Optional: notified with the recognised confidence (0..1). */
  onMatch?: (confidence: number) => void;
}

const DETECT_INTERVAL_MS = 250; // video: throttle detections

export default function MatchScanner({ mediaUrl, portraitUrl, onMatch }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const targetRef = useRef<Float32Array | null>(null);
  const facesRef = useRef<DetectedFace[]>([]);
  const matchRef = useRef<MatchResult | null>(null);
  const rafRef = useRef<number>(0);
  const lastDetectRef = useRef<number>(0);

  const [phase, setPhase] = useState<Phase>('loading');
  const [status, setStatus] = useState('Cargando modelos de visión…');
  const [confidence, setConfidence] = useState<number | null>(null);
  const [mediaType, setMediaType] = useState<'image' | 'video' | null>(null);
  const [proxiedSrc, setProxiedSrc] = useState<string | null>(null);

  /* ---- canvas sizing: match the rendered media box ---- */
  const fitCanvas = useCallback((naturalW: number, naturalH: number) => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return { sx: 1, sy: 1 };
    const rect = wrap.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    return { sx: rect.width / naturalW, sy: rect.height / naturalH };
  }, []);

  /* ---- drawing primitives ---- */
  const draw = useCallback(
    (opts: { sweepY?: number; revealRatio?: number; natW: number; natH: number }) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      const sx = canvas.width / opts.natW;
      const sy = canvas.height / opts.natH;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const reveal = opts.revealRatio ?? 1;
      const faces = facesRef.current;
      const match = matchRef.current;

      // landmark dots + face hulls
      for (const f of faces) {
        const isTarget = match && f === match.face && match.isMatch;
        ctx.fillStyle = isTarget ? '#39ff14' : 'rgba(0,229,255,0.9)';
        for (const p of f.landmarks) {
          const py = p.y * sy;
          if (py > canvas.height * reveal) continue; // sweep reveals points top→down
          ctx.beginPath();
          ctx.arc(p.x * sx, py, isTarget ? 2.2 : 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // tracker boxes
      for (const f of faces) {
        const isTarget = match && f === match.face && match.isMatch;
        const x = f.x * sx;
        const y = f.y * sy;
        const w = f.width * sx;
        const h = f.height * sy;
        if (isTarget) {
          drawBracketBox(ctx, x, y, w, h, '#39ff14');
          const label = `OBJETIVO ${Math.round((match!.confidence) * 100)}%`;
          drawLabel(ctx, label, x, y, '#39ff14', '#04210a');
        } else {
          ctx.strokeStyle = 'rgba(0,229,255,0.45)';
          ctx.lineWidth = 1;
          ctx.strokeRect(x, y, w, h);
        }
      }

      // scan sweep line
      if (opts.sweepY != null) {
        const sweepPx = opts.sweepY * canvas.height;
        const grad = ctx.createLinearGradient(0, sweepPx - 24, 0, sweepPx + 4);
        grad.addColorStop(0, 'rgba(0,229,255,0)');
        grad.addColorStop(1, 'rgba(0,229,255,0.55)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, sweepPx - 24, canvas.width, 28);
        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, sweepPx);
        ctx.lineTo(canvas.width, sweepPx);
        ctx.stroke();
      }
    },
    [],
  );

  /* ---- image flow ---- */
  const runImage = useCallback(async () => {
    const img = imgRef.current;
    if (!img || !targetRef.current) return;
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;
    fitCanvas(natW, natH);

    setStatus('Detectando rostros…');
    const faces = await describeAllFaces(img);
    facesRef.current = faces;
    if (!faces.length) {
      setPhase('nomatch');
      setStatus('No se detectaron rostros en la imagen.');
      return;
    }
    const best = matchAgainst(targetRef.current, faces);
    matchRef.current = best;

    // animate the sweep top→bottom, revealing points as it passes
    setPhase('scanning');
    setStatus('Escaneando biometría facial…');
    const start = performance.now();
    const DURATION = 2200;
    await new Promise<void>((resolve) => {
      const step = (t: number) => {
        const r = Math.min(1, (t - start) / DURATION);
        draw({ sweepY: r, revealRatio: r, natW, natH });
        if (r < 1) rafRef.current = requestAnimationFrame(step);
        else resolve();
      };
      rafRef.current = requestAnimationFrame(step);
    });

    draw({ revealRatio: 1, natW, natH });
    if (best?.isMatch) {
      setPhase('matched');
      setConfidence(best.confidence);
      setStatus(`Coincidencia confirmada · ${Math.round(best.confidence * 100)}%`);
      onMatch?.(best.confidence);
    } else {
      setPhase('nomatch');
      setStatus('Rostros analizados — sin coincidencia con el objetivo.');
    }
  }, [draw, fitCanvas, onMatch]);

  /* ---- video flow ---- */
  const runVideo = useCallback(() => {
    const video = videoRef.current;
    if (!video || !targetRef.current) return;
    setPhase('tracking');
    setStatus('Rastreando en video…');

    const loop = async () => {
      const natW = video.videoWidth || 640;
      const natH = video.videoHeight || 360;
      if (canvasRef.current && (canvasRef.current.width === 0 || canvasRef.current.height === 0)) {
        fitCanvas(natW, natH);
      }
      const now = performance.now();
      if (now - lastDetectRef.current > DETECT_INTERVAL_MS && !video.paused && !video.ended) {
        lastDetectRef.current = now;
        try {
          const faces = await describeAllFaces(video);
          facesRef.current = faces;
          const best = matchAgainst(targetRef.current!, faces);
          matchRef.current = best;
          if (best?.isMatch) {
            setConfidence(best.confidence);
            setStatus(`Objetivo en cuadro · ${Math.round(best.confidence * 100)}%`);
            onMatch?.(best.confidence);
          }
        } catch {
          /* skip frame */
        }
      }
      const sweepY = ((now / 1400) % 1); // perpetual sweep while tracking
      draw({ sweepY, revealRatio: 1, natW, natH });
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [draw, fitCanvas, onMatch]);

  /* ---- bootstrap ---- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadModels();
        if (cancelled) return;

        // 1) target descriptor from the portrait (same-origin proxy → canvas-safe)
        setStatus('Analizando retrato del objetivo…');
        const portrait = new Image();
        portrait.crossOrigin = 'anonymous';
        portrait.src = `/api/media-proxy?url=${encodeURIComponent(portraitUrl)}`;
        await portrait.decode().catch(() => {});
        const target = await describeFace(portrait);
        if (!target) {
          setPhase('error');
          setStatus('No pude leer el rostro del retrato objetivo.');
          return;
        }
        targetRef.current = target.descriptor;

        // 2) resolve the match media (post link → direct file)
        setStatus('Resolviendo publicación…');
        const res = await fetch(`/api/media-resolve?url=${encodeURIComponent(mediaUrl)}`);
        const meta = await res.json();
        if (cancelled) return;
        if (!meta.ok) {
          setPhase('error');
          setStatus('No se pudo resolver la media de la publicación.');
          return;
        }
        setMediaType(meta.type);
        setProxiedSrc(meta.proxied);
      } catch (err: any) {
        if (!cancelled) {
          setPhase('error');
          setStatus(`Error de visión: ${(err?.message || '').slice(0, 80)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
    };
  }, [mediaUrl, portraitUrl]);

  const phaseColor =
    phase === 'matched' || phase === 'tracking' ? '#39ff14' : phase === 'error' || phase === 'nomatch' ? '#ff6b6b' : '#00e5ff';

  return (
    <div className="match-scanner">
      <style>{`
        .match-scanner { position: relative; width: 100%; border-radius: 12px; overflow: hidden; background:#05070d; border:1px solid rgba(0,229,255,0.25); }
        .match-scanner .ms-media { display:block; width:100%; height:auto; }
        .match-scanner canvas { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
        .match-scanner .ms-hud { position:absolute; left:10px; top:10px; font:600 11px/1.3 ui-monospace,monospace; letter-spacing:.04em; padding:6px 10px; border-radius:6px; background:rgba(3,8,16,0.7); backdrop-filter:blur(4px); }
        .match-scanner .ms-dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:7px; vertical-align:middle; animation: mspulse 1.1s infinite; }
        @keyframes mspulse { 0%,100%{opacity:1} 50%{opacity:.35} }
      `}</style>

      <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
        {mediaType === 'video' && proxiedSrc ? (
          <video
            ref={videoRef}
            className="ms-media"
            src={proxiedSrc}
            crossOrigin="anonymous"
            muted
            autoPlay
            loop
            playsInline
            onLoadedData={() => runVideo()}
          />
        ) : mediaType === 'image' && proxiedSrc ? (
          <img
            ref={imgRef}
            className="ms-media"
            src={proxiedSrc}
            crossOrigin="anonymous"
            alt="match media"
            onLoad={() => runImage()}
          />
        ) : (
          <div style={{ padding: '48px 16px', textAlign: 'center', color: '#5b6b86', font: '13px ui-monospace,monospace' }}>
            {status}
          </div>
        )}
        <canvas ref={canvasRef} />
      </div>

      <div className="ms-hud" style={{ color: phaseColor }}>
        <span className="ms-dot" style={{ background: phaseColor }} />
        {status}
        {confidence != null && (phase === 'matched' || phase === 'tracking') && (
          <span style={{ marginLeft: 8, color: '#39ff14' }}>● MATCH {Math.round(confidence * 100)}%</span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  canvas helpers                                                     */
/* ------------------------------------------------------------------ */
function drawBracketBox(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
) {
  const L = Math.max(10, Math.min(w, h) * 0.25);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  const corners: Array<[number, number, number, number, number, number]> = [
    [x, y, x + L, y, x, y + L],
    [x + w, y, x + w - L, y, x + w, y + L],
    [x, y + h, x + L, y + h, x, y + h - L],
    [x + w, y + h, x + w - L, y + h, x + w, y + h - L],
  ];
  for (const [ax, ay, bx, by, cx, cy] of corners) {
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(ax, ay);
    ctx.lineTo(cx, cy);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  bg: string,
  fg: string,
) {
  ctx.font = '700 12px ui-monospace, monospace';
  const padX = 7;
  const w = ctx.measureText(text).width + padX * 2;
  const ly = Math.max(16, y - 20);
  ctx.fillStyle = bg;
  ctx.fillRect(x, ly, w, 18);
  ctx.fillStyle = fg;
  ctx.fillText(text, x + padX, ly + 13);
}
