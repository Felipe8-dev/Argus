/**
 * MiniMax T2A v2 — fallback de TTS cuando ElevenLabs queda sin cuota.
 * Plan del user es ilimitado. Devuelve MP3 (siempre) + PCM 16kHz (para
 * lip-sync de Simli).
 *
 * Docs: https://www.minimax.io/platform/document/T2A%20V2
 */

export interface MiniMaxTTSResult {
  mp3Base64: string | null;
  pcmBase64: string | null;
  error?: string;
}

const MINIMAX_TTS_ENDPOINT = process.env.MINIMAX_TTS_ENDPOINT || 'https://api.minimax.io/v1/t2a_v2';

async function callMiniMax(text: string, format: 'mp3' | 'pcm'): Promise<{ buffer: Buffer | null; error?: string }> {
  const key = process.env.MINIMAX_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID;
  if (!key || !groupId) return { buffer: null, error: 'minimax_unconfigured' };

  const model = process.env.MINIMAX_TTS_MODEL || 'speech-02-turbo';
  const voiceId = process.env.MINIMAX_TTS_VOICE || 'Spanish_SereneWoman';

  const audioSetting = format === 'mp3'
    ? { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 }
    : { sample_rate: 16000, bitrate: 256000, format: 'pcm', channel: 1 };

  const body = {
    model,
    text: text.slice(0, 600),
    stream: false,
    voice_setting: { voice_id: voiceId, speed: 1.0, vol: 1.0, pitch: 0 },
    audio_setting: audioSetting,
  };

  try {
    const res = await fetch(`${MINIMAX_TTS_ENDPOINT}?GroupId=${groupId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { buffer: null, error: `${res.status}: ${errText.slice(0, 160)}` };
    }
    const json: any = await res.json();
    const base = json?.base_resp;
    if (base && base.status_code !== 0) {
      return { buffer: null, error: `base_resp ${base.status_code}: ${base.status_msg}` };
    }
    const hexAudio = json?.data?.audio;
    if (!hexAudio || typeof hexAudio !== 'string') {
      return { buffer: null, error: 'no_audio_in_response' };
    }
    // MiniMax devuelve audio como hex string que hay que decodificar a binary.
    return { buffer: Buffer.from(hexAudio, 'hex') };
  } catch (err: any) {
    return { buffer: null, error: err?.message?.slice(0, 160) || 'minimax_throw' };
  }
}

export async function synthesizeMiniMax(text: string): Promise<MiniMaxTTSResult> {
  if (!text || !text.trim()) {
    return { mp3Base64: null, pcmBase64: null, error: 'empty_text' };
  }
  // MP3 (playback) + PCM (Simli lip-sync). Si MP3 falla no intentamos PCM.
  const mp3 = await callMiniMax(text, 'mp3');
  if (!mp3.buffer) {
    return { mp3Base64: null, pcmBase64: null, error: `mp3: ${mp3.error}` };
  }
  const pcm = await callMiniMax(text, 'pcm');
  return {
    mp3Base64: mp3.buffer.toString('base64'),
    pcmBase64: pcm.buffer ? pcm.buffer.toString('base64') : null,
    error: pcm.error ? `pcm: ${pcm.error}` : undefined,
  };
}
