'use client';

import { useEffect, useRef, useState } from 'react';

interface Message {
  role: 'operator' | 'agent';
  text: string;
  at: number;
}

interface Props {
  caseId: string | null;
}

const PROMPTS = [
  '¿Qué patrón debería buscar Sentinel en esta zona?',
  'Resume riesgos del caso actual',
  '¿Qué autoridad local debo notificar primero?',
];

/**
 * Struere co-pilot floating widget — collapsible chat bottom-right.
 * Surfacea el endpoint /api/struere/chat con contexto del caso activo.
 * Cuando Struere no está configurado responde "no configurado" pero
 * no rompe el flujo.
 */
export default function StruereCopilot({ caseId }: Props) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages, open]);

  const send = async (text?: string) => {
    const body = (text ?? input).trim();
    if (!body || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'operator', text: body, at: Date.now() }]);
    setBusy(true);
    try {
      const res = await fetch('/api/struere/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId, message: body }),
      });
      const json = await res.json();
      const reply = json.reply || json.message || json.text || (json.ok === false ? `(${json.error || 'sin respuesta'})` : 'sin respuesta');
      setMessages((m) => [...m, { role: 'agent', text: reply, at: Date.now() }]);
    } catch (err: any) {
      setMessages((m) => [...m, { role: 'agent', text: `(error: ${err?.message || 'red'})`, at: Date.now() }]);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className="copilot-fab"
        onClick={() => setOpen(true)}
        title="Co-piloto Struere"
      >
        <span className="copilot-fab-dot" />
        <span className="copilot-fab-label">co-piloto</span>
      </button>
    );
  }

  return (
    <aside className="copilot-panel">
      <header className="copilot-head">
        <div>
          <span className="copilot-kicker">Struere · operator co-pilot</span>
          <h4>Asistente táctico</h4>
        </div>
        <button className="copilot-close" onClick={() => setOpen(false)} aria-label="cerrar">×</button>
      </header>

      <div className="copilot-feed" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="copilot-empty">
            <p>Co-piloto del operador con contexto del caso activo. Probá una pregunta:</p>
            <div className="copilot-suggestions">
              {PROMPTS.map((p) => (
                <button key={p} onClick={() => send(p)} className="copilot-chip">{p}</button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`copilot-msg copilot-msg--${m.role}`}>
              <span className="copilot-msg-role">{m.role === 'operator' ? 'tú' : 'struere'}</span>
              <p>{m.text}</p>
            </div>
          ))
        )}
        {busy && <div className="copilot-msg copilot-msg--agent copilot-msg--busy">…</div>}
      </div>

      <form
        className="copilot-input"
        onSubmit={(e) => { e.preventDefault(); send(); }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={caseId ? 'Preguntá al co-piloto…' : 'Esperando caso activo'}
          disabled={busy || !caseId}
        />
        <button type="submit" disabled={busy || !input.trim() || !caseId}>↵</button>
      </form>
    </aside>
  );
}
