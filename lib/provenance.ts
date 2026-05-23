// Photo provenance + deepfake heuristics.
//
// Defensive layer: a fake-report or AI-generated portrait poisons every
// downstream agent (banner, search, alerts). Here we score every photo on
// three independent signals:
//
//   1. metadata: presence of EXIF (camera make, capture date) — modern AI
//      images usually have none. Empty EXIF is suspicious.
//   2. perceptual fingerprint: 16x16 grayscale dHash used as a stable id
//      that we can de-dup against future submissions to detect re-uploads.
//   3. semantic classifier: Gemini Vision asked to answer
//      "is this image a real photograph or AI-generated?" with confidence.
//
// We combine the three into a verdict (verified / suspect / unknown) and
// surface every signal so a human can audit the decision.

import sharp from 'sharp';

const GEMINI_KEYS = Array.from(new Set([
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  ...(process.env.GEMINI_API_KEYS || '').split(','),
].map((k) => k?.trim()).filter(Boolean))) as string[];

let geminiKeyIndex = 0;
function nextGeminiKey() {
  if (!GEMINI_KEYS.length) return null;
  const key = GEMINI_KEYS[geminiKeyIndex % GEMINI_KEYS.length];
  geminiKeyIndex++;
  return key;
}

export type ProvenanceVerdict = 'verified' | 'suspect' | 'unknown';

export interface ProvenanceReport {
  verdict: ProvenanceVerdict;
  score: number; // 0..1 — confidence that the photo is genuine
  signals: {
    hasExif: boolean;
    exifSize: number;
    width: number;
    height: number;
    format?: string;
    perceptualHash: string;
    ai: {
      checked: boolean;
      verdict?: 'real' | 'ai' | 'unsure';
      confidence?: number;
      reasoning?: string;
      provider?: string;
      error?: string;
    };
  };
}

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 16-byte difference-hash. Stable enough to detect re-uploads + light edits. */
async function perceptualHash(buffer: Buffer): Promise<string> {
  const { data } = await sharp(buffer)
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bits: number[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = data[row * 9 + col];
      const right = data[row * 9 + col + 1];
      bits.push(left < right ? 1 : 0);
    }
  }
  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b];
    bytes.push(byte);
  }
  return Buffer.from(bytes).toString('hex');
}

async function classifyWithGemini(buffer: Buffer, mime: string) {
  if (process.env.PROVENANCE_GEMINI_ENABLED === 'false') {
    return { checked: false as const };
  }
  if (!GEMINI_KEYS.length) return { checked: false as const, error: 'no_gemini_key' };

  const prompt = `Analiza la imagen y determina si es:
A) Una fotografia genuina tomada con una camara o telefono real.
B) Una imagen generada por IA (Midjourney, DALL-E, Stable Diffusion, GAN, etc).
C) Una imagen editada/manipulada o compuesta a partir de varias.

Senales que sugieren IA: ojos asimetricos, manos extranas, textura de piel
demasiado uniforme, fondo borroso de forma irreal, joyeria distorsionada,
texto ilegible, simetria perfecta del rostro.

Responde JSON en una sola linea:
{"verdict":"real|ai|unsure","confidence":0.0,"reasoning":"frase breve"}`;

  const model = process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  let lastErr = '';
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const key = nextGeminiKey();
    if (!key) break;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: prompt },
              { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
            ],
          }],
          generationConfig: { maxOutputTokens: 220, temperature: 0.1 },
        }),
      },
    );
    if (!response.ok) {
      lastErr = await response.text().catch(() => '');
      if (response.status === 429) continue;
      break;
    }
    const data = await response.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return { checked: true as const, error: 'no_json', provider: 'gemini' };
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const v = String(obj.verdict || '').toLowerCase();
      const verdict: 'real' | 'ai' | 'unsure' =
        v === 'real' || v === 'ai' ? (v as any) : 'unsure';
      const confidence = Math.max(0, Math.min(1, Number(obj.confidence) || 0));
      return {
        checked: true as const,
        verdict,
        confidence,
        reasoning: String(obj.reasoning || '').slice(0, 200),
        provider: 'gemini',
      };
    } catch {
      return { checked: true as const, error: 'parse_error', provider: 'gemini' };
    }
  }
  return { checked: true as const, error: lastErr.slice(0, 160) || 'gemini_failed' };
}

export async function inspectPhoto(url: string): Promise<ProvenanceReport> {
  const buffer = await downloadImage(url);

  const meta = await sharp(buffer).metadata().catch(() => ({} as Awaited<ReturnType<typeof sharp>['metadata']> extends infer T ? Partial<T extends Promise<infer U> ? U : never> : any));
  const exifBuf = (meta as any).exif as Buffer | undefined;
  const exifSize = exifBuf?.length || 0;
  const width = (meta as any).width || 0;
  const height = (meta as any).height || 0;
  const format = (meta as any).format;
  const mime = format ? `image/${format === 'jpg' ? 'jpeg' : format}` : 'image/jpeg';

  const phash = await perceptualHash(buffer).catch(() => '');
  const ai = await classifyWithGemini(buffer, mime).catch((err: any) => ({
    checked: true as const,
    error: err?.message?.slice(0, 160) || 'gemini_throw',
  }));

  // Score genuineness 0..1
  let score = 0.5;
  if (exifSize > 0) score += 0.2;
  if (width > 600 && height > 600) score += 0.05;
  if (ai.checked && 'verdict' in ai) {
    if (ai.verdict === 'real') score += 0.25 * (ai.confidence ?? 0.6);
    if (ai.verdict === 'ai') score -= 0.45 * (ai.confidence ?? 0.7);
    if (ai.verdict === 'unsure') score -= 0.05;
  }
  score = Math.max(0, Math.min(1, score));

  let verdict: ProvenanceVerdict;
  if (score >= 0.65) verdict = 'verified';
  else if (score <= 0.35) verdict = 'suspect';
  else verdict = 'unknown';

  return {
    verdict,
    score: Number(score.toFixed(3)),
    signals: {
      hasExif: exifSize > 0,
      exifSize,
      width,
      height,
      format,
      perceptualHash: phash,
      ai,
    },
  };
}
