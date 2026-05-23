'use client';
// LiveKit realtime voice intake — the migrated `/agente` experience.
//
// Replaces the push-to-talk + /api/agent-talk round-trip with a continuous
// LiveKit session driven by the Gemini Live worker (agent-worker/). The
// browser publishes the mic, plays the agent's audio, mirrors that audio into
// Simli for lip-sync, and listens for the `argus.ready` data event to fire the
// LangGraph pipeline with the uploaded photo.
import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from 'livekit-client';
import '../agente/agente.css';

type Status = 'idle' | 'connecting' | 'live' | 'speaking';

export default function AgenteLivePage() {
  const [status, setStatus] = useState<Status>('idle');
  const [started, setStarted] = useState(false);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [photoName, setPhotoName] = useState<string | null>(null);
  const [pipelineStatus, setPipelineStatus] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [simliReady, setSimliReady] = useState(false);
  const [log, setLog] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const roomRef = useRef<Room | null>(null);
  const simliRef = useRef<any>(null);
  const photoUrlRef = useRef<string | null>(null);
  const caseIdRef = useRef<string | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  caseIdRef.current = caseId;

  /* ---- Simli avatar (kept from the legacy page) ---- */
  const connectSimli = useCallback(async () => {
    const apiKey = process.env.NEXT_PUBLIC_SIMLI_API_KEY;
    const faceId = process.env.NEXT_PUBLIC_SIMLI_FACE_ID || 'tmp9i8bbq7c';
    if (!apiKey || !videoRef.current || !audioRef.current) return;
    try {
      const { SimliClient, generateSimliSessionToken, generateIceServers } = await import('simli-client');
      const token = await generateSimliSessionToken({
        apiKey,
        config: { faceId, handleSilence: true, maxSessionLength: 3600, maxIdleTime: 600 },
      });
      const ice = await generateIceServers(apiKey);
      const client = new SimliClient(token.session_token, videoRef.current!, audioRef.current!, ice);
      simliRef.current = client;
      await client.start();
      setSimliReady(true);
    } catch (err: any) {
      setLog((err?.message || String(err)).slice(0, 60));
    }
  }, []);

  /**
   * Tap a remote audio track and forward 16 kHz PCM16 chunks to Simli so the
   * avatar lip-syncs to the agent's voice. Falls back silently to plain
   * playback (the <audio> element) if Web Audio is unavailable.
   */
  const driveSimliFromTrack = useCallback((track: RemoteTrack) => {
    const simli = simliRef.current;
    if (!simli || track.kind !== Track.Kind.Audio) return;
    try {
      const ctx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = ctx;
      const stream = new MediaStream([track.mediaStreamTrack]);
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(2048, 1, 1);
      source.connect(processor);
      processor.connect(ctx.destination);
      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        try {
          simli.sendAudioData(new Uint8Array(pcm.buffer));
        } catch {
          /* avatar busy */
        }
      };
    } catch {
      /* Web Audio unavailable — plain playback still works */
    }
  }, []);

  /* ---- Pipeline trigger (browser owns photo + origin) ---- */
  const launchPipeline = useCallback(async (cId: string, description: any) => {
    setPipelineStatus('Activando pipeline...');
    try {
      await fetch('/api/launch-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId: cId, description, photoUrl: photoUrlRef.current }),
      });
      setPipelineStatus('Pipeline activado — los agentes están buscando');
      setReady(true);
    } catch {
      setPipelineStatus('Error al activar pipeline');
    }
  }, []);

  /* ---- LiveKit data events from the agent worker ---- */
  const onData = useCallback(
    (payload: Uint8Array, _p?: RemoteParticipant, _k?: any, topic?: string) => {
      let msg: any;
      try {
        msg = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }
      if (topic === 'argus.case' || msg.caseId) {
        if (msg.caseId) setCaseId(msg.caseId);
      }
      if (topic === 'argus.ready' || msg.description) {
        const cId = msg.caseId || caseIdRef.current;
        if (cId) launchPipeline(cId, msg.description);
      }
    },
    [launchPipeline],
  );

  /* ---- Connect to the LiveKit room ---- */
  const connect = useCallback(async () => {
    setStatus('connecting');
    setLog('Conectando a LiveKit...');
    try {
      const res = await fetch('/api/livekit/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const { token, url, error } = await res.json();
      if (error || !token) {
        setLog(error || 'LiveKit no configurado');
        setStatus('idle');
        return;
      }

      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;

      room
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication) => {
          if (track.kind === Track.Kind.Audio) {
            // Plain playback through the <audio> element…
            if (audioRef.current && !simliReady) track.attach(audioRef.current);
            // …and mirror into Simli for lip-sync when the avatar is up.
            driveSimliFromTrack(track);
            setStatus('speaking');
          }
        })
        .on(RoomEvent.DataReceived, onData)
        .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          setStatus(speakers.length ? 'speaking' : 'live');
        })
        .on(RoomEvent.Disconnected, () => setStatus('idle'));

      await room.connect(url, token);
      await room.localParticipant.setMicrophoneEnabled(true);
      setStatus('live');
      setLog('');
    } catch (err: any) {
      setLog((err?.message || String(err)).slice(0, 80));
      setStatus('idle');
    }
  }, [onData, driveSimliFromTrack, simliReady]);

  /* ---- Photo upload (unchanged) ---- */
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
        photoUrlRef.current = data.url;
        setPhotoName(file.name);
      } else {
        setPhotoName('Error al subir');
      }
    } catch {
      setPhotoName('Error al subir');
    }
  }, []);

  const handleStart = useCallback(async () => {
    setStarted(true);
    await connectSimli();
    await connect();
  }, [connectSimli, connect]);

  useEffect(() => {
    return () => {
      try {
        roomRef.current?.disconnect();
      } catch {}
      try {
        simliRef.current?.stop();
      } catch {}
      try {
        audioCtxRef.current?.close();
      } catch {}
    };
  }, []);

  if (!started) {
    return (
      <div className="agent-fullscreen">
        <div className="start-screen">
          <div className="start-title">ARGUS</div>
          <div className="start-sub">Intake de voz en tiempo real (LiveKit · Gemini Live)</div>
          <button className="start-btn" onClick={handleStart}>
            Iniciar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-fullscreen">
      <div className="avatar-video-container">
        <video ref={videoRef} autoPlay playsInline className="avatar-video" />
        <audio ref={audioRef} autoPlay />
        <div className={`avatar-ring ring-${status === 'speaking' ? 'speaking' : 'idle'}`} />
      </div>

      {photoName && <div className="photo-indicator">Foto subida: {photoName}</div>}
      {pipelineStatus && <div className="pipeline-indicator">{pipelineStatus}</div>}

      <div className="bottom-bar">
        <div className="status-text">
          {status === 'connecting' && (log || 'Conectando...')}
          {status === 'live' && 'En vivo — habla con Radar'}
          {status === 'speaking' && 'Radar está hablando...'}
          {status === 'idle' && (log || 'Sesión finalizada')}
        </div>

        <div className="controls">
          <input
            type="file"
            accept="image/*"
            capture="environment"
            ref={fileInputRef}
            onChange={handlePhotoUpload}
            hidden
          />
          <button className="ctrl-btn" onClick={() => fileInputRef.current?.click()} title="Enviar foto">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <circle cx="12" cy="12" r="3" />
              <path d="M9 2h6l1.5 3h-9z" />
            </svg>
          </button>
        </div>

        {!simliReady && (
          <button className="avatar-btn" onClick={connectSimli}>
            {log || 'Iniciar avatar'}
          </button>
        )}
        {ready && (
          <a href="/dashboard" className="dash-link">
            Ver Dashboard en vivo →
          </a>
        )}
      </div>
    </div>
  );
}
