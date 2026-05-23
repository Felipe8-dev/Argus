// Multi-provider vision comparison. Tries MiniMax-VL first, falls back to
// Gemini Vision. Both are called with the same prompt and must return:
//   { confidence: number 0..1, reasoning: string, visible_background?: boolean }

export interface Verdict {
  confidence: number;
  reasoning: string;
  visible_background?: boolean;
  provider: 'minimax' | 'gemini';
}

export interface ImageData {
  base64: string;
  mimeType: string;
}

function clamp(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function getMime(url: string, contentType: string | null) {
  if (contentType?.startsWith('image/')) return contentType.split(';')[0];
  if (url.toLowerCase().endsWith('.png')) return 'image/png';
  if (url.toLowerCase().endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

export async function downloadImage(url: string): Promise<ImageData> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Cannot download image ${response.status} from ${url.slice(0, 80)}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    base64: buffer.toString('base64'),
    mimeType: getMime(url, response.headers.get('content-type')),
  };
}

function buildPrompt(desc: Record<string, any>) {
  return `Eres un verificador forense entrenado para una demo controlada de busqueda de personas desaparecidas. Compara dos imagenes:
- Imagen A: foto aportada por la familia de la persona desaparecida.
- Imagen B: foto publica/focalizada donde la persona podria aparecer (incluso de fondo, en grupo o parcialmente visible).

Descripcion del caso:
- Nombre: ${desc.nombre || '?'}
- Edad aprox: ${desc.edad_aprox || '?'}
- Genero: ${desc.genero || '?'}
- Cabello: ${desc.cabello || '?'}
- Tono de piel: ${desc.tono_piel || '?'}
- Ropa reportada: ${desc.ropa || '?'}
- Senas particulares: ${(desc.senales_particulares || []).join(', ') || '-'}

Si NO ves a la persona en la imagen B, devuelve confidence=0.
Si la ves dudosa o de fondo, devuelve entre 0.4 y 0.7.
Si es claramente la misma persona, devuelve >=0.8.

Responde exclusivamente JSON valido en una linea, sin markdown:
{"confidence":0.0,"reasoning":"frase breve en espanol","visible_background":true}`;
}

function parseVerdict(text: string): Omit<Verdict, 'provider'> {
  // Strip ``` fences first so models that wrap JSON in markdown still parse.
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      return {
        confidence: clamp(Number(obj.confidence)),
        reasoning: String(obj.reasoning || '').slice(0, 240),
        visible_background: obj.visible_background !== false,
      };
    } catch {}
  }
  // Tolerant fallback: extract any decimal between 0 and 1 from the text.
  // If the model returned a plain sentence ("Estoy 0.85 seguro de que…")
  // we still rescue a usable confidence instead of failing the photo.
  const numMatch = cleaned.match(/\b0?\.\d+|\b1\.0+\b/);
  if (numMatch) {
    return {
      confidence: clamp(Number(numMatch[0])),
      reasoning: cleaned.slice(0, 240),
      visible_background: true,
    };
  }
  throw new Error('Vision response had no JSON object');
}

// ---------- MiniMax-VL ----------
const MINIMAX_ENDPOINT = 'https://api.minimax.io/v1/text/chatcompletion_v2';

async function callMinimax(desc: Record<string, any>, portrait: ImageData, candidate: ImageData): Promise<Verdict> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error('MINIMAX_API_KEY missing');
  const model = process.env.MINIMAX_VISION_MODEL || 'MiniMax-VL-01';

  const response = await fetch(MINIMAX_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildPrompt(desc) },
            { type: 'image_url', image_url: { url: `data:${portrait.mimeType};base64,${portrait.base64}` } },
            { type: 'image_url', image_url: { url: `data:${candidate.mimeType};base64,${candidate.base64}` } },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 240,
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`MiniMax vision ${response.status}: ${err.slice(0, 180)}`);
  }
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || data?.reply || '';
  if (!text) throw new Error('MiniMax returned empty content');
  const parsed = parseVerdict(typeof text === 'string' ? text : JSON.stringify(text));
  return { ...parsed, provider: 'minimax' };
}

// ---------- Gemini fallback ----------
const GEMINI_KEYS = Array.from(new Set([
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  ...(process.env.GEMINI_API_KEYS || '').split(','),
].map((key) => key?.trim()).filter(Boolean))) as string[];

let geminiKeyIndex = 0;
function nextGeminiKey() {
  if (!GEMINI_KEYS.length) return null;
  const key = GEMINI_KEYS[geminiKeyIndex % GEMINI_KEYS.length];
  geminiKeyIndex++;
  return key;
}

async function callGemini(desc: Record<string, any>, portrait: ImageData, candidate: ImageData): Promise<Verdict> {
  if (!GEMINI_KEYS.length) throw new Error('No GEMINI_API_KEY configured');

  const model = process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  let lastError = '';

  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const key = nextGeminiKey();
    if (!key) break;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: buildPrompt(desc) },
            { inlineData: { mimeType: portrait.mimeType, data: portrait.base64 } },
            { inlineData: { mimeType: candidate.mimeType, data: candidate.base64 } },
          ],
        }],
        generationConfig: { maxOutputTokens: 260, temperature: 0.1 },
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const parsed = parseVerdict(text);
      return { ...parsed, provider: 'gemini' };
    }
    lastError = await response.text().catch(() => '');
    if (response.status !== 429) break;
  }
  throw new Error(`Gemini vision failed: ${lastError.slice(0, 180)}`);
}

// ---------- Orchestrator ----------
export async function compareImages(
  desc: Record<string, any>,
  portraitUrl: string,
  candidateUrl: string,
): Promise<Verdict> {
  const [portrait, candidate] = await Promise.all([
    downloadImage(portraitUrl),
    downloadImage(candidateUrl),
  ]);

  // Gate MiniMax vision separately. Most plans don't include MiniMax-VL,
  // and the noisy "empty content" failures swamp the logs. Default off
  // unless the operator explicitly opts in with MINIMAX_VISION_ENABLED=true.
  const minimaxVisionEnabled =
    process.env.MINIMAX_VISION_ENABLED === 'true' &&
    Boolean(process.env.MINIMAX_API_KEY);

  if (minimaxVisionEnabled) {
    try {
      return await callMinimax(desc, portrait, candidate);
    } catch (err: any) {
      console.error('[vision] MiniMax failed, falling back to Gemini:', err.message);
    }
  }

  return await callGemini(desc, portrait, candidate);
}
