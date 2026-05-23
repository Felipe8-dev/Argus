'use client';
import { useState, useRef, useCallback, useEffect } from 'react';
import './agente.css';

type Status = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

export default function AgentePage() {
  const [status, setStatus] = useState<Status>('idle');
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [transcript, setTranscript] = useState('');
  const [caseId, setCaseId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [simliReady, setSimliReady] = useState(false);
  const [started, setStarted] = useState(false);
  const [simliLog, setSimliLog] = useState('');
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoName, setPhotoName] = useState<string | null>(null);
  const [description, setDescription] = useState<any>(null);
  const [pipelineStatus, setPipelineStatus] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const simliRef = useRef<any>(null);
  const recognitionRef = useRef<any>(null);
  const accumulatedTextRef = useRef('');
  const handleUserMessageRef = useRef<(text: string) => void>(() => {});
  const messagesRef = useRef(messages);
  const caseIdRef = useRef(caseId);
  const photoUrlRef = useRef<string | null>(null);
  const descriptionRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  messagesRef.current = messages;
  caseIdRef.current = caseId;
  photoUrlRef.current = photoUrl;
  descriptionRef.current = description;

  // ---- Connect Simli ----
  const connectSimli = useCallback(async () => {
    const apiKey = process.env.NEXT_PUBLIC_SIMLI_API_KEY;
    const faceId = process.env.NEXT_PUBLIC_SIMLI_FACE_ID || 'tmp9i8bbq7c';
    if (!apiKey || !videoRef.current || !audioRef.current) return;
    if (simliRef.current) {
      try { await simliRef.current.stop(); } catch {}
      simliRef.current = null; setSimliReady(false);
      await new Promise(r => setTimeout(r, 2000));
    }
    setStatus('connecting'); setSimliLog('Conectando...');
    try {
      const { SimliClient, generateSimliSessionToken, generateIceServers } = await import('simli-client');
      const token = await generateSimliSessionToken({ apiKey, config: { faceId, handleSilence: true, maxSessionLength: 3600, maxIdleTime: 600 } });
      const ice = await generateIceServers(apiKey);
      const client = new SimliClient(token.session_token, videoRef.current!, audioRef.current!, ice);
      simliRef.current = client;
      await client.start();
      setSimliReady(true); setSimliLog(''); setStatus('idle');
    } catch (err: any) {
      const msg = err?.message || String(err);
      setSimliLog(msg.includes('RATE LIMIT') ? 'Espera unos segundos e intenta de nuevo' : msg.slice(0, 60));
      setStatus('idle');
    }
  }, []);

  const handleStart = useCallback(() => { setStarted(true); setStatus('idle'); }, []);
  useEffect(() => { return () => { if (simliRef.current) { try { simliRef.current.stop(); } catch {} } }; }, []);

  // ---- Send PCM to Simli with noise gate ----
  const sendPcmToSimli = useCallback(async (pcmBase64: string) => {
    const client = simliRef.current;
    if (!client || !simliReady) return false;
    try {
      const raw = atob(pcmBase64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const samples = new Int16Array(bytes.buffer.slice(0));
      for (let i = 0; i < samples.length; i++) { if (Math.abs(samples[i]) < 400) samples[i] = 0; }
      const gated = new Uint8Array(samples.buffer);
      const chunkBytes = 3200;
      let offset = 0;
      const interval = setInterval(() => {
        if (offset >= gated.length) { clearInterval(interval); setStatus('idle'); return; }
        client.sendAudioData(gated.slice(offset, offset + chunkBytes));
        offset += chunkBytes;
      }, 100);
      return true;
    } catch { return false; }
  }, [simliReady]);

  const playMp3Fallback = useCallback((mp3Base64: string) => {
    const buf = Uint8Array.from(atob(mp3Base64), c => c.charCodeAt(0));
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => { setStatus('idle'); URL.revokeObjectURL(url); };
    audio.play().catch(() => setStatus('idle'));
  }, []);

  // ---- Upload photo via server API ----
  const handlePhotoUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setPhotoName('Subiendo...');
    const form = new FormData();
    form.append('photo', file);

    try {
      const res = await fetch('/api/upload-photo', { method: 'POST', body: form });
      const data = await res.json();

      if (data.url) {
        setPhotoUrl(data.url);
        setPhotoName(file.name);
        handleUserMessageRef.current('El operador acaba de enviar una imagen de referencia para el caso ARGUS.');
      } else {
        setPhotoName('Error al subir');
        console.error('Upload failed:', data.error);
      }
    } catch (err) {
      setPhotoName('Error al subir');
      console.error('Upload error:', err);
    }
  }, []);

  // ---- Launch search pipeline after interview ----
  const launchPipeline = useCallback(async (cId: string, desc: any) => {
    setPipelineStatus('Activando pipeline...');
    try {
      await fetch('/api/launch-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId: cId, description: desc, photoUrl: photoUrlRef.current }),
      });
      setPipelineStatus('Pipeline activado — los agentes están buscando');
      setReady(true);
    } catch {
      setPipelineStatus('Error al activar pipeline');
    }
  }, []);

  // ---- Send to API ----
  const handleUserMessage = useCallback(async (text: string) => {
    setStatus('thinking'); setTranscript('');
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    try {
      const res = await fetch('/api/agent-talk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, history: messagesRef.current, caseId: caseIdRef.current }),
      });
      const data = await res.json();
      if (data.error) { setStatus('idle'); return; }

      setMessages(prev => [...prev, { role: 'assistant', content: data.reply }]);
      if (data.caseId) setCaseId(data.caseId);
      if (data.description) {
        setDescription(data.description);
        if (data.readyForSearch && data.caseId) {
          await launchPipeline(data.caseId, data.description);
        }
      }

      if (data.audioPcmBase64 || data.audioMp3Base64) {
        setStatus('speaking');
        let sent = false;
        if (simliReady && data.audioPcmBase64) {
          try { sent = await sendPcmToSimli(data.audioPcmBase64); } catch {}
        }
        // Always play MP3 as audible fallback if Simli didn't handle it
        if (!sent) {
          if (data.audioMp3Base64) playMp3Fallback(data.audioMp3Base64);
          else setStatus('idle');
        }
      } else { setStatus('idle'); }
    } catch { setStatus('idle'); }
  }, [sendPcmToSimli, playMp3Fallback, launchPipeline]);

  handleUserMessageRef.current = handleUserMessage;

  // ---- Speech Recognition ----
  const startListening = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR(); rec.lang = 'es-CO'; rec.continuous = true; rec.interimResults = true;
    accumulatedTextRef.current = '';
    rec.onresult = (e: any) => {
      let f = '', interim = '';
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) f += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      accumulatedTextRef.current = (f + interim).trim();
      setTranscript(accumulatedTextRef.current);
    };
    rec.onerror = () => { accumulatedTextRef.current = ''; setStatus('idle'); };
    rec.onend = () => {
      const text = accumulatedTextRef.current; accumulatedTextRef.current = '';
      if (text) handleUserMessageRef.current(text); else setStatus('idle');
    };
    recognitionRef.current = rec; rec.start(); setStatus('listening'); setTranscript('');
  }, []);
  const stopListening = useCallback(() => { recognitionRef.current?.stop(); }, []);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => { if (e.code === 'Space' && e.target === document.body && status === 'idle' && started) { e.preventDefault(); startListening(); } };
    const ku = (e: KeyboardEvent) => { if (e.code === 'Space' && e.target === document.body && status === 'listening') { e.preventDefault(); stopListening(); } };
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku);
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); };
  }, [status, started, startListening, stopListening]);

  // ---- Start screen ----
  if (!started) {
    return (
      <div className="agent-fullscreen">
        <div className="start-screen">
          <div className="start-title">ARGUS</div>
          <div className="start-sub">Civilian resilience intake agent</div>
          <button className="start-btn" onClick={handleStart}>Iniciar</button>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-fullscreen">
      {/* Avatar */}
      <div className="avatar-video-container">
        <video ref={videoRef} autoPlay playsInline className="avatar-video" />
        <audio ref={audioRef} autoPlay />
        <div className={`avatar-ring ring-${status}`} />
      </div>

      {/* Photo indicator */}
      {photoName && (
        <div className="photo-indicator">Foto subida: {photoName}</div>
      )}

      {/* Pipeline status */}
      {pipelineStatus && (
        <div className="pipeline-indicator">{pipelineStatus}</div>
      )}

      {/* Bottom */}
      <div className="bottom-bar">
        {transcript && <div className="transcript">{transcript}</div>}
        <div className="status-text">
          {status === 'connecting' && (simliLog || 'Conectando...')}
          {status === 'idle' && 'Mantén ESPACIO para reportar una señal'}
          {status === 'listening' && 'Escuchando...'}
          {status === 'thinking' && 'Fusionando señales...'}
          {status === 'speaking' && ''}
        </div>

        <div className="controls">
          {/* Photo upload */}
          <input type="file" accept="image/*" capture="environment" ref={fileInputRef} onChange={handlePhotoUpload} hidden />
          <button className="ctrl-btn" onClick={() => fileInputRef.current?.click()} disabled={status !== 'idle'} title="Enviar foto">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M9 2h6l1.5 3h-9z"/>
            </svg>
          </button>

          {/* Mic */}
          <button
            className={`talk-btn talk-${status}`}
            onMouseDown={() => { if (status === 'idle') startListening(); }}
            onMouseUp={() => { if (status === 'listening') stopListening(); }}
            onTouchStart={() => { if (status === 'idle') startListening(); }}
            onTouchEnd={() => { if (status === 'listening') stopListening(); }}
            disabled={status !== 'idle' && status !== 'listening'}
          >
            {status === 'listening' ? <div className="mic-recording" /> : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0014 0"/><line x1="12" y1="17" x2="12" y2="22"/>
              </svg>
            )}
          </button>
        </div>

        {!simliReady && status !== 'connecting' && (
          <button className="avatar-btn" onClick={connectSimli}>
            {simliLog || 'Iniciar avatar'}
          </button>
        )}
        {ready && <a href="/dashboard" className="dash-link">Ver Dashboard en vivo →</a>}
      </div>
    </div>
  );
}
