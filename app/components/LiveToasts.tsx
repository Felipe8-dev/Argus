'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Toast {
  id: string;
  kind: 'pattern' | 'match' | 'deepfake' | 'anchor' | 'published' | 'witness' | 'manual';
  title: string;
  body?: string;
  at: number;
}

interface Props {
  caseId: string | null;
}

const TOAST_TTL_MS = 6500;
const KIND_META: Record<Toast['kind'], { icon: string; tone: string }> = {
  pattern:    { icon: '🚨', tone: 'red' },
  match:      { icon: '👁',  tone: 'amber' },
  deepfake:   { icon: '🚫', tone: 'red' },
  anchor:     { icon: '🔒', tone: 'blue' },
  published:  { icon: '🟢', tone: 'jade' },
  witness:    { icon: '💬', tone: 'amber' },
  manual:     { icon: '📍', tone: 'jade' },
};

/**
 * Suscripción realtime a pipeline_events del caso activo, traduce
 * eventos a notificaciones efímeras esquina superior derecha.
 * Max 4 visibles, auto-dismiss en 6.5s, animadas con slide-in.
 */
export default function LiveToasts({ caseId }: Props) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    if (!caseId || !supabase) return;

    // Limpiar a cambio de caso.
    setToasts([]);

    const push = (t: Omit<Toast, 'id' | 'at'>) => {
      const id = `${t.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-3), { ...t, id, at: Date.now() }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== id));
      }, TOAST_TTL_MS);
    };

    const channel = supabase
      .channel(`toasts:${caseId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pipeline_events', filter: `case_id=eq.${caseId}` }, (payload: any) => {
        const ev = payload?.new;
        if (!ev) return;
        const agent = ev.agent;
        const event = ev.event;
        const p = ev.payload || {};

        if (agent === 'sentinel' && p?.kind === 'trafficking_pattern_alert') {
          push({ kind: 'pattern', title: 'Patrón de trata detectado', body: `${p.cases || '?'} casos · ${p.zone?.label || 'zona priorizada'}` });
          return;
        }
        if (agent === 'intel.provenance' && p?.verdict === 'suspect') {
          push({ kind: 'deepfake', title: 'Portrait sospechoso filtrado', body: `score ${Math.round((p.score || 0) * 100)}% · verificación humana requerida` });
          return;
        }
        if (agent === 'pulse' && p?.step === 'filecoin_anchor' && p?.cid) {
          push({ kind: 'anchor', title: 'Caso anclado en Filecoin', body: `CID ${String(p.cid).slice(0, 10)}…` });
          return;
        }
        if (agent === 'agent3' && p?.step === 'facebook_publish_found') {
          push({ kind: 'published', title: 'Coincidencia publicada', body: `Banner ENCONTRADA · ${Math.round((p.confidence || 0) * 100)}% confianza` });
          return;
        }
        if (agent === 'agent2' && p?.step === 'manual_sighting') {
          push({ kind: 'manual', title: 'Avistamiento manual registrado', body: `Operador marcó punto · ${Math.round((p.confidence || 0) * 100)}% confianza` });
          return;
        }
        if ((agent === 'agent2' || agent === 'ghost') && event === 'complete' && (p?.match_confidence || p?.confidence)) {
          const c = Math.round((p.match_confidence || p.confidence) * 100);
          if (c >= 70) push({ kind: 'match', title: `Coincidencia visual ${c}%`, body: p.place_label || p.source_site || '' });
          return;
        }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'matches', filter: `case_id=eq.${caseId}` }, (payload: any) => {
        const m = payload?.new;
        if (!m) return;
        if (m.source_site === 'facebook-harvest' || m.source_site === 'nitter-harvest') {
          push({ kind: 'witness', title: 'Tip de testigo recibido', body: m.place_label || m.source_site });
        }
      })
      .subscribe();

    return () => { supabase?.removeChannel(channel); };
  }, [caseId]);

  if (!toasts.length) return null;

  return (
    <div className="toast-stack">
      {toasts.map((t) => {
        const meta = KIND_META[t.kind];
        return (
          <div key={t.id} className={`toast toast--${meta.tone}`}>
            <span className="toast-icon">{meta.icon}</span>
            <div className="toast-body">
              <strong>{t.title}</strong>
              {t.body && <span>{t.body}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
