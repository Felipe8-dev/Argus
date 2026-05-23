'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import './agente/agente.css';
import './dashboard/dashboard.css';
import type { AgentMarker, AgentZone } from './dashboard/MapView';
import InteractiveParticles from './components/InteractiveParticles';
import BlueskyTicker from './components/BlueskyTicker';
import ProvenancePill from './components/ProvenancePill';
import AnchorPill from './components/AnchorPill';
import { type OverlayState, type OverlayKey } from './components/MapOverlayToggle';
import ExternalSignalRail from './components/ExternalSignalRail';
import CaseTimer from './components/CaseTimer';
import StruereCopilot from './components/StruereCopilot';
import LiveToasts from './components/LiveToasts';
import HeatmapLegend from './components/HeatmapLegend';
import OperatorControls from './components/OperatorControls';

const MapView = dynamic(() => import('./dashboard/MapView'), { ssr: false });

const AGENT_COLORS: Record<string, string> = {
  agent0: '#0f766e',
  agent2: '#f59e0b',
  agent3: '#a855f7',
  agent4: '#ef4444',
  pipeline: '#14b8a6',
  atlas: '#14b8a6',
  ghost: '#f59e0b',
  sentinel: '#0ea5e9',
  pulse: '#ef4444',
};

function colorForAgent(agent: string) {
  return AGENT_COLORS[agent.toLowerCase()] || '#0f766e';
}

type Status = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';
type Stage = 'avatar' | 'operation';
type MapMode = 'threat' | 'routes' | 'agents';

interface CaseRow {
  id: string;
  reporter_phone: string;
  status: string;
  description: any;
  portrait_url: string | null;
  created_at: string;
  evidence_cid?: string | null;
  portrait_sha256?: string | null;
}

interface PipelineEvent {
  id: string;
  case_id: string;
  agent: string;
  event: string;
  payload: any;
  created_at: string;
}

interface MatchRow {
  id: string;
  case_id: string;
  confidence: number | null;
  place_label: string | null;
  gps_lat: number | null;
  gps_lon: number | null;
  source_site: string | null;
  source_url: string | null;
  photo_url: string | null;
  created_at: string;
}

const AGENTS = [
  ['agent0', 'Intake', 'Entrevista y normaliza el caso'],
  ['agent3', 'Echo', 'Genera banner y publicacion'],
  ['atlas', 'Atlas', 'Proyecta rutas y sectores probables'],
  ['agent2', 'Ghost', 'Busca coincidencias visuales'],
  ['sentinel', 'Sentinel', 'Detecta clusters de avistamientos'],
  ['pulse', 'Pulse', 'Notifica a familia y autoridades'],
];

const demoDescription = {
  nombre: 'Mariana Torres',
  edad_aprox: 22,
  genero: 'femenino',
  ropa: 'camiseta blanca, jean azul',
  senales_particulares: ['lunar en la mejilla derecha'],
  ultima_ubicacion: 'Bocagrande, Cartagena',
  fecha_desaparicion: '2026-05-16',
  hora_aproximada: '08:40',
};

export default function ArgusApp() {
  const [stage, setStage] = useState<Stage>('avatar');
  const [status, setStatus] = useState<Status>('idle');
  const [started, setStarted] = useState(false);
  const [simliReady, setSimliReady] = useState(false);
  const [simliLog, setSimliLog] = useState('');
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [lastReply, setLastReply] = useState('Soy ARGUS. Voy a ayudarte a activar una busqueda temprana.');
  const [transcript, setTranscript] = useState('');
  const [caseId, setCaseId] = useState<string | null>(null);
  const [description, setDescription] = useState<any>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoName, setPhotoName] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [authorityEmail, setAuthorityEmail] = useState('');
  const [showPhoneModal, setShowPhoneModal] = useState(false);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [pipelineStatus, setPipelineStatus] = useState('Esperando entrevista');
  const [mode, setMode] = useState<MapMode>('agents');
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [mapCenter, setMapCenter] = useState<{ lat: number; lng: number } | null>(null);
  // External signal overlays (NASA FIRMS · USGS · GDACS) — default ON.
  // El usuario las puede apagar desde el toggle pill, pero queremos que
  // se vean apenas carga la operación, sin click previo.
  const [overlayState, setOverlayState] = useState<OverlayState>({ firms: true, usgs: true, gdacs: true });
  const [firmsLayer, setFirmsLayer] = useState<any>(null);
  const [usgsLayer, setUsgsLayer] = useState<any>(null);
  const [gdacsLayer, setGdacsLayer] = useState<any>(null);
  const [firmsConfigured, setFirmsConfigured] = useState(true);
  // Operator controls
  const [searchRadiusKm, setSearchRadiusKm] = useState(3);
  const [minConfidence, setMinConfidence] = useState(0);
  const [pinMode, setPinMode] = useState(false);
  const [pinFeedback, setPinFeedback] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const simliRef = useRef<any>(null);
  const recognitionRef = useRef<any>(null);
  const accumulatedTextRef = useRef('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef(messages);
  const caseIdRef = useRef(caseId);
  const photoUrlRef = useRef(photoUrl);
  const phoneRef = useRef(phone);
  // Guards against the Simli auto-reconnect loop: once an attempt fails,
  // give up and let the user retry via the manual "Activar video avatar" button.
  const simliAttemptsRef = useRef(0);
  const simliBlockedRef = useRef(false);

  messagesRef.current = messages;
  caseIdRef.current = caseId;
  photoUrlRef.current = photoUrl;
  phoneRef.current = phone;

  const selectedCase = useMemo(() => {
    if (caseId) return cases.find((item) => item.id === caseId) || null;
    return cases[0] || null;
  }, [caseId, cases]);

  const selectedEvents = useMemo(() => {
    const id = selectedCase?.id || caseId;
    return events
      .filter((event) => !id || event.case_id === id)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [events, selectedCase, caseId]);

  const selectedMatches = useMemo(() => {
    const id = selectedCase?.id || caseId;
    return matches.filter((match) => !id || match.case_id === id);
  }, [matches, selectedCase, caseId]);

  const latestMatch = useMemo(() => {
    const best = selectedMatches
      .filter((m) => Number.isFinite(m.gps_lat) && Number.isFinite(m.gps_lon))
      .sort((a, b) => {
        const ca = Number(a.confidence || 0);
        const cb = Number(b.confidence || 0);
        if (cb !== ca) return cb - ca;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      })[0];
    if (!best) return null;
    return {
      id: best.id,
      lng: Number(best.gps_lon),
      lat: Number(best.gps_lat),
      photoUrl: best.photo_url,
      portraitUrl: selectedCase?.portrait_url || null,
      sourceUrl: best.source_url,
      sourceSite: best.source_site,
      placeLabel: best.place_label,
      confidence: best.confidence,
      personName: selectedCase?.description?.nombre || null,
    };
  }, [selectedMatches, selectedCase]);

  const livePoints = useMemo(() => {
    const fromMatches = selectedMatches
      .filter((match) => match.gps_lat && match.gps_lon)
      .map((match) => ({
        lng: match.gps_lon!,
        lat: match.gps_lat!,
        label: match.place_label || match.source_site || 'Coincidencia',
        severity: Math.max(0.55, Number(match.confidence || 0.65)),
        risk: Number(match.confidence || 0) >= 0.75 ? 'critical' : 'high',
      }));

    const fromEvents = selectedEvents
      .map((event) => {
        const payload = event.payload || {};
        const lat = payload.gps_lat || payload.lat || payload.latitude;
        const lng = payload.gps_lon || payload.lng || payload.lon || payload.longitude;
        if (!lat || !lng) return null;
        return {
          lng: Number(lng),
          lat: Number(lat),
          label: payload.place_label || payload.status || event.agent,
          severity: payload.confidence || 0.68,
          risk: event.event === 'error' ? 'high' : 'medium',
        };
      })
      .filter(Boolean) as { lng: number; lat: number; label: string; severity: number; risk: string }[];

    return [...fromMatches, ...fromEvents];
  }, [selectedMatches, selectedEvents]);

  const agentStates = useMemo(() => {
    return AGENTS.map(([key, name, detail]) => {
      const last = selectedEvents.find((event) => event.agent === key);
      const state = last?.event === 'complete' ? 'complete' : last?.event === 'error' ? 'error' : last ? 'active' : 'queued';
      return { key, name, detail, state, last };
    });
  }, [selectedEvents]);

  // Live scanning zones: last zone per (agent, label) pair, colored by agent.
  const agentZones = useMemo<AgentZone[]>(() => {
    const byKey = new Map<string, AgentZone>();
    // Iterate oldest → newest so the latest write wins.
    const ordered = [...selectedEvents].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    for (const event of ordered) {
      const zone = event.payload?.zone;
      if (!zone || zone.lat == null || zone.lng == null) continue;
      const key = `${event.agent}::${zone.label || 'zone'}`;
      byKey.set(key, {
        agent: event.agent,
        label: zone.label || event.agent,
        lat: Number(zone.lat),
        lng: Number(zone.lng),
        radiusKm: Number(zone.radius_km || zone.radiusKm || 0.6),
        status: event.event === 'complete' ? 'complete' : event.event === 'error' ? 'error' : 'scanning',
        color: colorForAgent(event.agent),
      });
    }
    return Array.from(byKey.values());
  }, [selectedEvents]);

  // Latest position per agent — drives the moving dot + aura on the map.
  const agentMarkers = useMemo<AgentMarker[]>(() => {
    const latest = new Map<string, AgentMarker>();
    const ordered = [...selectedEvents].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    for (const event of ordered) {
      const pos = event.payload?.agent_position;
      if (!pos || pos.lat == null || pos.lng == null) continue;
      latest.set(event.agent, {
        agent: event.agent,
        lat: Number(pos.lat),
        lng: Number(pos.lng),
        color: colorForAgent(event.agent),
        label: event.agent,
      });
    }
    return Array.from(latest.values());
  }, [selectedEvents]);

  const loadLiveData = useCallback(async () => {
    if (!supabase) return;
    const [{ data: c }, { data: e }, { data: m }] = await Promise.all([
      supabase.from('cases').select('*').order('created_at', { ascending: false }).limit(12),
      supabase.from('pipeline_events').select('*').order('created_at', { ascending: false }).limit(100),
      supabase.from('matches').select('*').order('created_at', { ascending: false }).limit(50),
    ]);
    if (c) setCases(c as CaseRow[]);
    if (e) setEvents(e as PipelineEvent[]);
    if (m) setMatches(m as MatchRow[]);
  }, []);

  useEffect(() => {
    if (stage !== 'operation' || !supabase) return;
    loadLiveData();
    const channel = supabase
      .channel('argus-live-operation')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cases' }, () => loadLiveData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pipeline_events' }, () => loadLiveData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, () => loadLiveData())
      .subscribe();
    return () => { supabase?.removeChannel(channel); };
  }, [stage, loadLiveData]);

  // Rehydrate mapCenter from the selected case's stored geo, so a refresh
  // mid-operation still centers the map even if the pipeline response was lost.
  useEffect(() => {
    if (mapCenter) return;
    const geo = selectedCase?.description?.geo;
    const lat = geo?.gps_lat;
    const lng = geo?.gps_lon;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      setMapCenter({ lat: Number(lat), lng: Number(lng) });
    }
  }, [selectedCase, mapCenter]);

  // Fetch external signal overlays (FIRMS · USGS · GDACS) on toggle.
  // USGS y GDACS son globales y sin key; FIRMS necesita NASA_FIRMS_MAP_KEY
  // y centro del caso. Cada feed se cachea 10min server-side. Refresh
  // automático cada 90s para que el demo se sienta vivo.
  useEffect(() => {
    let refreshTimer: number | undefined;

    const fetchAll = () => {
      if (overlayState.usgs) {
        fetch('/api/intel/usgs').then((r) => r.json()).then((j) => setUsgsLayer(j.data)).catch(() => {});
      }
      if (overlayState.gdacs) {
        fetch('/api/intel/gdacs').then((r) => r.json()).then((j) => setGdacsLayer(j.data)).catch(() => {});
      }
      if (overlayState.firms && mapCenter) {
        fetch(`/api/intel/firms?lat=${mapCenter.lat}&lng=${mapCenter.lng}`)
          .then((r) => r.json())
          .then((j) => {
            setFirmsLayer(j.data);
            if (j.configured === false) setFirmsConfigured(false);
          })
          .catch(() => {});
      }
    };

    fetchAll();
    refreshTimer = window.setInterval(fetchAll, 90_000);
    return () => { if (refreshTimer) window.clearInterval(refreshTimer); };
  }, [overlayState, mapCenter]);

  useEffect(() => {
    return () => {
      if (simliRef.current) {
        try { simliRef.current.stop(); } catch {}
      }
    };
  }, []);

  const closeAvatar = useCallback(() => {
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
    }
    if (simliRef.current) {
      try { simliRef.current.stop(); } catch {}
      simliRef.current = null;
    }
    setSimliReady(false);
    setStage('operation');
    setMode('agents');
  }, []);

  const connectSimli = useCallback(async (manual = false) => {
    const apiKey = process.env.NEXT_PUBLIC_SIMLI_API_KEY;
    const faceId = process.env.NEXT_PUBLIC_SIMLI_FACE_ID || 'tmp9i8bbq7c';
    if (!apiKey || !videoRef.current || !audioRef.current) return;
    if (manual) {
      simliAttemptsRef.current = 0;
      simliBlockedRef.current = false;
    }
    setStatus('connecting');
    setSimliLog('Conectando avatar');
    simliAttemptsRef.current += 1;
    try {
      const { SimliClient, generateSimliSessionToken, generateIceServers } = await import('simli-client');
      const token = await generateSimliSessionToken({ apiKey, config: { faceId, handleSilence: true, maxSessionLength: 3600, maxIdleTime: 600 } });
      const ice = await generateIceServers(apiKey);
      const client = new SimliClient(token.session_token, videoRef.current, audioRef.current, ice);
      simliRef.current = client;
      await client.start();
      setSimliReady(true);
      setStatus('idle');
      setSimliLog('');
      simliAttemptsRef.current = 0;
      simliBlockedRef.current = false;
    } catch (error: any) {
      setStatus('idle');
      const reason = error?.message?.slice(0, 70) || 'No se pudo iniciar avatar';
      setSimliLog(reason);
      // After 2 failed attempts, stop the auto-reconnect loop. The user can
      // hit the manual "Activar video avatar" button to try again.
      if (simliAttemptsRef.current >= 2) {
        simliBlockedRef.current = true;
        setSimliLog(`${reason} — click para reintentar`);
        console.error('[simli] giving up after', simliAttemptsRef.current, 'attempts:', reason);
      }
    }
  }, []);

  useEffect(() => {
    if (!started || stage !== 'avatar' || simliReady || status === 'connecting') return;
    if (simliBlockedRef.current) return;
    const timer = window.setTimeout(() => { void connectSimli(); }, 250);
    return () => window.clearTimeout(timer);
  }, [connectSimli, simliReady, stage, started, status]);

  const playMp3Fallback = useCallback((mp3Base64: string) => {
    const buf = Uint8Array.from(atob(mp3Base64), (char) => char.charCodeAt(0));
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => { setStatus('idle'); URL.revokeObjectURL(url); };
    audio.play().catch(() => setStatus('idle'));
  }, []);

  const sendPcmToSimli = useCallback(async (pcmBase64: string) => {
    const client = simliRef.current;
    if (!client || !simliReady) return false;
    try {
      const raw = atob(pcmBase64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const samples = new Int16Array(bytes.buffer.slice(0));
      for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) < 400) samples[i] = 0;
      const gated = new Uint8Array(samples.buffer);
      let offset = 0;
      const interval = setInterval(() => {
        if (offset >= gated.length) { clearInterval(interval); setStatus('idle'); return; }
        client.sendAudioData(gated.slice(offset, offset + 3200));
        offset += 3200;
      }, 100);
      return true;
    } catch {
      return false;
    }
  }, [simliReady]);

  const launchPipeline = useCallback(async (activeCaseId: string, desc: any) => {
    setPipelineStatus('Activando agentes');

    const response = await fetch('/api/launch-pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        caseId: activeCaseId,
        description: desc,
        photoUrl: photoUrlRef.current,
        authorityEmail,
      }),
    });

    // Get the geo coordinates from the pipeline response to center the map.
    // launch-pipeline returns geo as { gps_lat, gps_lon, place_label } — not lat/lng.
    try {
      const result = await response.json();
      const lat = result?.geo?.gps_lat;
      const lng = result?.geo?.gps_lon;
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        setMapCenter({ lat: Number(lat), lng: Number(lng) });
      }
    } catch {}

    setPipelineStatus('Agentes desplegados');
    await loadLiveData();
    closeAvatar();
  }, [authorityEmail, closeAvatar, loadLiveData]);

  const sendUserMessage = useCallback(async (text: string) => {
    const clean = text.trim();
    if (!clean) return;

    if (!phoneRef.current) {
      setPendingText(clean);
      setShowPhoneModal(true);
      setLastReply('Necesito tu numero de WhatsApp para avisarte avances y posibles coincidencias.');
      return;
    }

    setStatus('thinking');
    setTranscript('');
    setMessages((prev) => [...prev, { role: 'user', content: clean }]);

    try {
      const response = await fetch('/api/agent-talk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: clean,
          history: messagesRef.current,
          caseId: caseIdRef.current,
          phone: phoneRef.current || null,
        }),
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);

      if (data.reply) {
        setLastReply(data.reply);
        setMessages((prev) => [...prev, { role: 'assistant', content: data.reply }]);
      }
      if (data.caseId) setCaseId(data.caseId);
      if (data.description) setDescription(data.description);

      if (data.audioPcmBase64 || data.audioMp3Base64) {
        setStatus('speaking');
        let sent = false;
        if (data.audioPcmBase64) sent = await sendPcmToSimli(data.audioPcmBase64);
        if (!sent && data.audioMp3Base64) playMp3Fallback(data.audioMp3Base64);
        if (!sent && !data.audioMp3Base64) setStatus('idle');
      } else {
        setStatus('idle');
      }

      if (data.readyForSearch && data.caseId) {
        await launchPipeline(data.caseId, data.description || description || demoDescription);
      }
    } catch {
      setStatus('idle');
      setLastReply('No pude procesar esa respuesta ahora. Puedes intentar de nuevo o completar la demo.');
    }
  }, [description, launchPipeline, playMp3Fallback, sendPcmToSimli]);

  const startListening = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setLastReply('Tu navegador no soporta reconocimiento de voz. Usa Chrome o Edge en escritorio.');
      return;
    }
    // Defensive: if a previous instance is still around, stop and drop it.
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
      recognitionRef.current = null;
    }

    const rec = new SR();
    rec.lang = 'es-CO';
    rec.continuous = true;
    rec.interimResults = true;
    accumulatedTextRef.current = '';
    rec.onresult = (event: any) => {
      let finalText = '';
      let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        if (event.results[i].isFinal) finalText += event.results[i][0].transcript;
        else interim += event.results[i][0].transcript;
      }
      accumulatedTextRef.current = (finalText + interim).trim();
      setTranscript(accumulatedTextRef.current);
    };
    rec.onerror = (event: any) => {
      const reason = event?.error || 'desconocido';
      console.error('[speech] recognition error:', reason);
      const messages: Record<string, string> = {
        'not-allowed': 'Permite el microfono en tu navegador para hablar.',
        'service-not-allowed': 'El servicio de voz requiere HTTPS o localhost.',
        'no-speech': 'No se escucho nada. Intenta de nuevo.',
        'audio-capture': 'No encontre microfono. Revisa tu dispositivo.',
      };
      if (messages[reason]) setLastReply(messages[reason]);
      setStatus('idle');
    };
    rec.onend = () => {
      const text = accumulatedTextRef.current;
      accumulatedTextRef.current = '';
      recognitionRef.current = null;
      if (text) void sendUserMessage(text);
      else setStatus('idle');
    };

    recognitionRef.current = rec;
    try {
      rec.start();
      setStatus('listening');
    } catch (err: any) {
      console.error('[speech] start failed:', err?.message || err);
      recognitionRef.current = null;
      setLastReply('No pude iniciar el microfono. Asegurate de tener permisos y vuelve a intentarlo.');
      setStatus('idle');
    }
  }, [sendUserMessage]);

  const stopListening = useCallback(() => {
    const rec = recognitionRef.current;
    if (!rec) return;
    try { rec.stop(); } catch {}
  }, []);

  useEffect(() => {
    // Push-to-talk with space bar. Only ignore the key when the user is typing
    // in a real text field — otherwise (focus on a button or empty body) it
    // should still work, which is how operators normally hold space.
    const isTextField = (el: EventTarget | null) => {
      const node = el as HTMLElement | null;
      if (!node) return false;
      const tag = node.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || node.isContentEditable;
    };

    const down = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      if (event.repeat) return; // ignore auto-repeat while held
      if (isTextField(event.target)) return;
      if (stage !== 'avatar' || !started || status !== 'idle') return;
      event.preventDefault();
      startListening();
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      if (isTextField(event.target)) return;
      if (stage !== 'avatar' || status !== 'listening') return;
      event.preventDefault();
      stopListening();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [stage, started, status, startListening, stopListening]);

  async function handlePhotoUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset the input so the same file can be re-selected after a failed upload.
    event.target.value = '';
    if (!file) return;
    setPhotoName(file.name);
    const form = new FormData();
    form.append('photo', file);
    try {
      const response = await fetch('/api/upload-photo', { method: 'POST', body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.url) {
        const detail = data?.error ? ` (${String(data.error).slice(0, 80)})` : '';
        console.error('[upload-photo] failed:', response.status, data);
        setLastReply(`No pude subir la foto, intenta de nuevo.${detail}`);
        return;
      }
      setPhotoUrl(data.url);
      setLastReply('Foto recibida. La usare para el banner y como referencia visual.');
      await sendUserMessage('El familiar acaba de enviar una foto reciente de la persona desaparecida.');
    } catch (err: any) {
      console.error('[upload-photo] network/throw:', err);
      setLastReply(`No pude subir la foto, intenta de nuevo. (${err?.message?.slice(0, 80) || 'red'})`);
    }
  }

  function savePhone() {
    const normalized = phone.replace(/\D/g, '');
    if (normalized.length < 10) return;
    setPhone(normalized);
    phoneRef.current = normalized;
    setShowPhoneModal(false);
    setLastReply(`Numero confirmado: ${normalized}. Continuemos.`);
    if (pendingText) {
      const next = pendingText;
      setPendingText(null);
      setTimeout(() => void sendUserMessage(next), 80);
    }
  }

  async function completeDemo() {
    const response = await fetch('/api/cases/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: phone || '3054879364',
        authorityEmail,
        description: description || demoDescription,
      }),
    });
    const data = await response.json();
    const id = data.caseId || `ARG-DEMO-${Date.now().toString().slice(-5)}`;
    setCaseId(id);
    await launchPipeline(id, description || demoDescription);
  }

  if (stage === 'avatar') {
    return (
      <main className="avatar-gate">
        {!started ? (
          <section className="avatar-start">
            <div className="argus-particles-wrap">
              <InteractiveParticles className="argus-particles" />
            </div>
            <p>Agente de respuesta temprana civil</p>
            <button onClick={() => { setStarted(true); setStatus('idle'); }}>Iniciar agente</button>
          </section>
        ) : (
          <>
            <div className="avatar-video-container avatar-gate-video">
              <video ref={videoRef} autoPlay playsInline className="avatar-video" />
              <audio ref={audioRef} autoPlay />
              <div className={`avatar-ring ring-${status}`} />
            </div>

            <div className="avatar-caption">
              {lastReply}
            </div>

            {photoName && <div className="photo-indicator">Foto: {photoName}</div>}
            <div className="pipeline-indicator">{pipelineStatus}</div>

            <div className="bottom-bar avatar-gate-controls">
              {transcript && <div className="transcript">{transcript}</div>}
              <div className="status-text">
                {status === 'connecting' && (simliLog || 'Conectando...')}
                {status === 'idle' && 'Manten ESPACIO o presiona el microfono'}
                {status === 'listening' && 'Escuchando...'}
                {status === 'thinking' && 'Procesando entrevista...'}
                {status === 'speaking' && ''}
              </div>
              <div className="controls">
                <input type="file" accept="image/*" ref={fileInputRef} onChange={handlePhotoUpload} hidden />
                <button className="ctrl-btn" onClick={() => fileInputRef.current?.click()} disabled={status === 'connecting'} title="Subir foto">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M9 2h6l1.5 3h-9z"/></svg>
                </button>
                <button
                  className={`talk-btn talk-${status}`}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    if (status === 'idle') startListening();
                  }}
                  onPointerUp={(e) => {
                    e.preventDefault();
                    if (status === 'listening') stopListening();
                    (e.currentTarget as HTMLButtonElement).blur();
                  }}
                  onPointerLeave={() => { if (status === 'listening') stopListening(); }}
                  onContextMenu={(e) => e.preventDefault()}
                  disabled={status !== 'idle' && status !== 'listening'}
                >
                  {status === 'listening' ? <div className="mic-recording" /> : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0014 0"/><line x1="12" y1="17" x2="12" y2="22"/></svg>
                  )}
                </button>
                <button className="ctrl-btn" onClick={() => setShowPhoneModal(true)} title="Numero de contacto">#</button>
              </div>
              {!simliReady && status !== 'connecting' && (
                <button className="avatar-btn" onClick={() => connectSimli(true)}>{simliLog || 'Activar video avatar'}</button>
              )}
            </div>
          </>
        )}

        {showPhoneModal && (
          <div className="modal-backdrop">
            <div className="phone-modal">
              <div className="section-kicker">Contacto WhatsApp</div>
              <h3>Numero para recibir avances</h3>
              <p>Ejemplo Colombia: <strong>573054879364</strong>. Para la demo puedes usar <strong>3054879364</strong>.</p>
              <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="3054879364" autoFocus />
              <input value={authorityEmail} onChange={(event) => setAuthorityEmail(event.target.value)} placeholder="correo autoridad demo (opcional)" />
              <div className="modal-actions">
                <button onClick={() => setShowPhoneModal(false)}>Cancelar</button>
                <button onClick={savePhone}>Guardar</button>
              </div>
            </div>
          </div>
        )}
      </main>
    );
  }

  return (
    <main className="post-agent-shell">
      {/* Map = full-screen background canvas */}
      <div className="ops-map-bg">
        <MapView
          mode={mode}
          selectedCase={selectedCase?.id || caseId || 'ARGUS'}
          livePoints={livePoints.filter((p) => (p.severity ?? 1) >= minConfidence)}
          mapCenter={mapCenter}
          latestMatch={latestMatch && (latestMatch.confidence ?? 1) >= minConfidence ? latestMatch : null}
          portraitUrl={selectedCase?.portrait_url || null}
          agentZones={agentZones}
          agentMarkers={agentMarkers}
          firmsLayer={overlayState.firms ? firmsLayer : null}
          usgsLayer={overlayState.usgs ? usgsLayer : null}
          gdacsLayer={overlayState.gdacs ? gdacsLayer : null}
          searchRadiusKm={searchRadiusKm}
          pinMode={pinMode}
          onManualPin={async (lng, lat) => {
            if (!selectedCase?.id) {
              setPinFeedback('Falta caso activo');
              return;
            }
            setPinMode(false);
            setPinFeedback('Guardando avistamiento…');
            try {
              const res = await fetch('/api/sighting/manual', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  caseId: selectedCase.id,
                  lat, lng,
                  confidence: 0.9,
                  placeLabel: `Operador marcó (${lat.toFixed(4)}, ${lng.toFixed(4)})`,
                }),
              });
              const json = await res.json();
              setPinFeedback(json.ok ? '✓ Avistamiento registrado' : `✗ ${json.error || 'falló'}`);
            } catch (err: any) {
              setPinFeedback(`✗ ${err?.message || 'red'}`);
            } finally {
              setTimeout(() => setPinFeedback(null), 4000);
            }
          }}
        />
      </div>

      {/* Top glass bar — single source of truth for op id, timer, actions */}
      <header className="ops-glass-bar">
        <div className="ops-bar-tag">
          ARGUS · OP-{(selectedCase?.id || 'NEW').slice(0, 4).toUpperCase()}
          <span className="ops-bar-phase">{(selectedCase?.status || 'INTAKE').toUpperCase()}</span>
        </div>
        <CaseTimer
          caseId={selectedCase?.id || null}
          startAt={selectedCase?.created_at || null}
          firstMatchAt={selectedMatches.length > 0 ? selectedMatches[selectedMatches.length - 1].created_at : null}
        />
        <div className="ops-bar-actions">
          <a href="/defense" className="ops-action ops-action--primary">Defense</a>
          <button className="ops-action" onClick={() => setStage('avatar')}>Reabrir</button>
        </div>
      </header>

      {/* Case widget — top-left */}
      <aside className="ops-widget ops-widget--case">
        <div className="ops-case-head">
          <div className="ops-case-portrait">
            {selectedCase?.portrait_url ? (
              <img src={selectedCase.portrait_url} alt="portrait" />
            ) : (
              <span>SIN<br />PORTRAIT</span>
            )}
          </div>
          <div className="ops-case-headline">
            <h2 className="ops-case-name">
              {selectedCase?.description?.nombre || 'Sujeto por confirmar'}
            </h2>
            <span className="ops-case-stage">{pipelineStatus || 'EN BÚSQUEDA'}</span>
            <div className="ops-case-badges">
              <ProvenancePill caseId={selectedCase?.id || null} />
              <AnchorPill caseId={selectedCase?.id || null} evidenceCid={selectedCase?.evidence_cid || null} />
              {selectedCase?.id && (
                <a
                  className="ops-pdf-btn"
                  href={`/api/case/${selectedCase.id}/pdf`}
                  target="_blank"
                  rel="noreferrer"
                  title="Descargar dossier forense firmado"
                >
                  📄 dossier PDF
                </a>
              )}
            </div>
          </div>
        </div>
        <dl className="ops-case-meta">
          {selectedCase?.description?.edad_aprox != null && (
            <div><dt>Edad</dt><dd>{selectedCase.description.edad_aprox} años</dd></div>
          )}
          {selectedCase?.description?.genero && (
            <div><dt>Género</dt><dd>{selectedCase.description.genero}</dd></div>
          )}
          {selectedCase?.description?.ultima_ubicacion && (
            <div><dt>Última visto</dt><dd>{selectedCase.description.ultima_ubicacion}</dd></div>
          )}
          {selectedCase?.description?.fecha_desaparicion && (
            <div>
              <dt>Fecha</dt>
              <dd>
                {selectedCase.description.fecha_desaparicion}
                {selectedCase.description.hora_aproximada ? ` · ${selectedCase.description.hora_aproximada}` : ''}
              </dd>
            </div>
          )}
          {selectedCase?.description?.ropa && (
            <div><dt>Ropa</dt><dd>{selectedCase.description.ropa}</dd></div>
          )}
          {Array.isArray(selectedCase?.description?.senales_particulares) && selectedCase!.description.senales_particulares.length > 0 && (
            <div><dt>Señales</dt><dd>{selectedCase!.description.senales_particulares.join(', ')}</dd></div>
          )}
        </dl>
        <OperatorControls
          radiusKm={searchRadiusKm}
          onRadiusChange={setSearchRadiusKm}
          minConfidence={minConfidence}
          onConfidenceChange={setMinConfidence}
          pinMode={pinMode}
          onTogglePin={() => setPinMode((p) => !p)}
        />
        {pinFeedback && <div className="pin-feedback">{pinFeedback}</div>}
      </aside>

      {/* Agents widget — top-right */}
      <aside className="ops-widget ops-widget--agents">
        <header className="ops-widget-head">
          <h2 data-index="/01">Agentes</h2>
          <span>
            {agentStates.filter((a) => a.state === 'complete').length}/{agentStates.length}
          </span>
        </header>
        <div className="ops-agents">
          {agentStates.map((agent) => (
            <article className={agent.state} key={agent.key}>
              <span className="ops-agent-dot" />
              <div>
                <strong>{agent.name}</strong>
                <span>{agent.last?.payload?.status || agent.detail}</span>
              </div>
              <em>{agent.state}</em>
            </article>
          ))}
        </div>
      </aside>

      {/* Telemetry widget — bottom-left */}
      <aside className="ops-widget ops-widget--telemetry">
        <header className="ops-widget-head">
          <h2 data-index="/02">Telemetría</h2>
          <time>LIVE</time>
        </header>
        <div className="ops-feed">
          {selectedEvents.length === 0 ? (
            <div className="ops-feed-empty">Esperando primer evento del pipeline</div>
          ) : (
            selectedEvents.slice(0, 10).map((event) => (
              <article key={event.id}>
                <time>
                  {new Date(event.created_at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}
                </time>
                <strong>{event.agent}</strong>
                <span>{event.payload?.status || event.payload?.step || event.event}</span>
              </article>
            ))
          )}
        </div>
      </aside>

      {/* Map mode tabs — bottom-center floating pill */}
      <div className="ops-widget ops-widget--maptabs">
        {(['threat', 'routes', 'agents'] as const).map((item) => (
          <button key={item} className={mode === item ? 'active' : ''} onClick={() => setMode(item)}>
            {item === 'threat' ? 'Calor' : item === 'routes' ? 'Rutas' : '3D'}
          </button>
        ))}
      </div>

      {/* Live external signal rail — chips clickeables = toggle layer */}
      <ExternalSignalRail
        firms={firmsLayer}
        usgs={usgsLayer}
        gdacs={gdacsLayer}
        caseCenter={mapCenter}
        state={overlayState}
        onToggle={(k: OverlayKey) => setOverlayState((s) => ({ ...s, [k]: !s[k] }))}
        firmsConfigured={firmsConfigured}
      />

      {/* Bluesky live ticker — right side, debajo del agents widget */}
      <BlueskyTicker caseId={selectedCase?.id || null} />

      {/* Struere co-pilot floating FAB — bottom right */}
      <StruereCopilot caseId={selectedCase?.id || null} />

      {/* Live notifications — top-right toast stack */}
      <LiveToasts caseId={selectedCase?.id || null} />

      {/* Heatmap legend — small floating */}
      <HeatmapLegend />

      {showPhoneModal && (
        <div className="modal-backdrop">
          <div className="phone-modal">
            <div className="section-kicker">Contacto WhatsApp</div>
            <h3>Número de la familia</h3>
            <p>
              Argus enviará avances y posibles coincidencias por WhatsApp. Formato Colombia:
              {' '}<strong>3054879364</strong>.
            </p>
            <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="3054879364" autoFocus />
            <input value={authorityEmail} onChange={(event) => setAuthorityEmail(event.target.value)} placeholder="correo autoridad (opcional)" />
            <div className="modal-actions">
              <button onClick={() => setShowPhoneModal(false)}>Cancelar</button>
              <button onClick={savePhone}>Guardar</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
