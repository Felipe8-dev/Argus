'use client';

import { useEffect, useRef } from 'react';

/**
 * Ported from devxel-nexus-webflow/src/components/InteractiveParticles.tsx
 * Paleta cambiada de azul/violeta a verde jade (matchea --signal-jade #3DAA94)
 * para encajar con la identidad visual de Argus def/acc.
 *
 * Las partículas se arman formando la palabra activa, ciclan cada ~4.4s
 * (explosión + reform), el mouse las repele, click → explota.
 * Pure 2D canvas. Cero deps. Cleanup completo.
 */

const DEFAULT_WORDS = ['ARGUS', 'DEFIENDE', 'VERIFICA', 'ALERTA'];

interface Props {
  className?: string;
  active?: boolean;
  /** Palabras por las que cicla el wordmark (~4.4s cada una). */
  words?: string[];
  /** Hue base del HSL. 160 ≈ jade verde. Default Argus. */
  hueBase?: number;
  hueRange?: number;
}

interface Particle {
  x: number; y: number;
  tx: number; ty: number;
  vx: number; vy: number;
  size: number;
  hue: number;
  alive: boolean;
}

export default function InteractiveParticles({
  className,
  active = true,
  words = DEFAULT_WORDS,
  hueBase = 150,
  hueRange = 35,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wordsKey = words.join('|');

  useEffect(() => {
    if (!active) return;

    const wordList = wordsKey ? wordsKey.split('|') : DEFAULT_WORDS;
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d', { alpha: true });
    if (!ctx) return;

    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

    let width = 0, height = 0;
    let particles: Particle[] = [];
    let raf = 0;
    let visible = true;
    let wordIndex = 0;
    let stopped = false;
    let hasTargets = false;
    let lastRepair = 0;
    let delayedWordT: number | undefined;
    const mouse = { x: -9999, y: -9999, active: false, down: false };
    let explodeUntil = 0;

    const offscreen = document.createElement('canvas');
    const octx = offscreen.getContext('2d', { willReadFrequently: true })!;

    const sampleText = (text: string): Array<[number, number]> => {
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      offscreen.width = w;
      offscreen.height = h;
      octx.clearRect(0, 0, w, h);
      octx.fillStyle = '#fff';
      const fontSize = Math.max(42, Math.min(w / Math.max(text.length, 1), h * 0.82));
      octx.font = `900 ${fontSize}px ui-sans-serif, system-ui, -apple-system, "Segoe UI"`;
      octx.textAlign = 'center';
      octx.textBaseline = 'middle';
      octx.fillText(text, w / 2, h / 2);
      const data = octx.getImageData(0, 0, w, h).data;
      const points: Array<[number, number]> = [];
      const step = 4;
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const idx = (y * w + x) * 4;
          if (data[idx + 3] > 128) points.push([x, y]);
        }
      }
      return points;
    };

    const fitParticles = (text: string) => {
      const pts = sampleText(text);
      hasTargets = pts.length > 0;
      if (!hasTargets) return;

      for (let i = pts.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [pts[i], pts[j]] = [pts[j], pts[i]];
      }

      while (particles.length < pts.length) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          tx: 0, ty: 0,
          vx: 0, vy: 0,
          size: 1.4 + Math.random() * 1.6,
          hue: hueBase + Math.random() * hueRange,
          alive: true,
        });
      }
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (i < pts.length) {
          p.alive = true;
          p.tx = pts[i][0];
          p.ty = pts[i][1];
        } else {
          p.alive = false;
          p.tx = Math.random() * width;
          p.ty = height + 80;
        }
      }
      if (particles.length > pts.length * 1.3) particles = particles.slice(0, pts.length);
    };

    const resize = () => {
      const rect = cv.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      width = Math.round(rect.width);
      height = Math.round(rect.height);
      cv.width = Math.floor(width * dpr);
      cv.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fitParticles(wordList[wordIndex]);
    };
    let resizeT: number | undefined;
    const onResize = () => {
      window.clearTimeout(resizeT);
      resizeT = window.setTimeout(resize, 120);
    };
    window.addEventListener('resize', onResize);

    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeT);
      resizeT = window.setTimeout(resize, 60);
    });
    ro.observe(cv);

    let retries = 0;
    const ensure = () => {
      if (stopped) return;
      if (width < 4 || height < 4 || !hasTargets) {
        resize();
        if (retries++ < 120) requestAnimationFrame(ensure);
      }
    };
    requestAnimationFrame(ensure);

    const onMove = (e: MouseEvent) => {
      const rect = cv.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
      mouse.active = true;
    };
    const onLeave = () => { mouse.active = false; mouse.x = -9999; mouse.y = -9999; };
    const onDown = () => {
      mouse.down = true;
      explodeUntil = performance.now() + 700;
      for (const p of particles) {
        const dx = p.x - mouse.x;
        const dy = p.y - mouse.y;
        const d = Math.hypot(dx, dy) || 1;
        const force = Math.min(18, 600 / (d + 60));
        p.vx += (dx / d) * force;
        p.vy += (dy / d) * force;
      }
    };
    const onUp = () => { mouse.down = false; };
    cv.addEventListener('mousemove', onMove);
    cv.addEventListener('mouseleave', onLeave);
    cv.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);

    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible) resize();
    }, { threshold: 0 });
    io.observe(cv);

    const cycleId = window.setInterval(() => {
      explodeUntil = performance.now() + 600;
      for (const p of particles) {
        const ang = Math.random() * Math.PI * 2;
        const force = 6 + Math.random() * 10;
        p.vx += Math.cos(ang) * force;
        p.vy += Math.sin(ang) * force;
      }
      delayedWordT = window.setTimeout(() => {
        wordIndex = (wordIndex + 1) % wordList.length;
        fitParticles(wordList[wordIndex]);
      }, 280);
    }, 4400);

    resize();

    const handleVisibility = () => {
      if (document.hidden) {
        visible = false;
      } else {
        visible = true;
        resize();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    const wake = () => { visible = true; resize(); };
    window.addEventListener('pageshow', wake);
    window.addEventListener('focus', wake);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!visible) return;

      if ((width < 4 || height < 4 || !hasTargets || particles.length === 0) && performance.now() - lastRepair > 250) {
        lastRepair = performance.now();
        resize();
        return;
      }

      ctx.clearRect(0, 0, width, height);

      const now = performance.now();
      const exploding = now < explodeUntil;

      for (const p of particles) {
        if (!p.alive) continue;

        if (!exploding && !reduce) {
          const dx = p.tx - p.x;
          const dy = p.ty - p.y;
          p.vx += dx * 0.018;
          p.vy += dy * 0.018;
        }

        if (mouse.active) {
          const mx = p.x - mouse.x;
          const my = p.y - mouse.y;
          const d2 = mx * mx + my * my;
          const R = 110;
          if (d2 < R * R) {
            const d = Math.sqrt(d2) || 1;
            const force = (1 - d / R) * (mouse.down ? 6 : 3);
            p.vx += (mx / d) * force;
            p.vy += (my / d) * force;
          }
        }

        p.vx *= 0.86;
        p.vy *= 0.86;
        p.x += p.vx;
        p.y += p.vy;

        const speed = Math.hypot(p.vx, p.vy);
        const alpha = Math.min(0.95, 0.55 + speed * 0.05);
        // Saturación 78% en vez de 92% para verde más sobrio (no neón).
        ctx.fillStyle = `hsla(${p.hue}, 78%, ${48 + Math.min(20, speed * 1.2)}%, ${alpha})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size + Math.min(1.5, speed * 0.18), 0, Math.PI * 2);
        ctx.fill();
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.clearInterval(cycleId);
      window.clearTimeout(delayedWordT);
      window.removeEventListener('resize', onResize);
      window.clearTimeout(resizeT);
      cv.removeEventListener('mousemove', onMove);
      cv.removeEventListener('mouseleave', onLeave);
      cv.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pageshow', wake);
      window.removeEventListener('focus', wake);
      io.disconnect();
      ro.disconnect();
    };
  }, [active, wordsKey, hueBase, hueRange]);

  return (
    <canvas
      ref={ref}
      className={className}
      role="img"
      aria-label="Argus particle wordmark"
    />
  );
}
