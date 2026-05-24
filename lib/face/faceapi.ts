// Browser-only face-api helpers (lazy-loaded). Never import this server-side.
//
// One stack covers the whole CV demo:
//   • SSD MobileNet v1  → detects faces, incl. small/background ones
//   • Face Landmark 68  → the 68 points drawn as the "scanning" overlay
//   • Face Recognition  → 128-d descriptors to match the missing person
//
// Models are served from /public/models (copied from @vladmandic/face-api).

export type FaceApi = typeof import('@vladmandic/face-api');

export interface DetectedFace {
  // bounding box in the media's natural pixel space
  x: number;
  y: number;
  width: number;
  height: number;
  landmarks: Array<{ x: number; y: number }>;
  descriptor: Float32Array;
}

export interface MatchResult {
  face: DetectedFace;
  distance: number; // 0 = identical
  confidence: number; // 0..1, derived from distance
  isMatch: boolean;
}

let faceapiPromise: Promise<FaceApi> | null = null;
let modelsLoaded = false;

const MODEL_URL = '/models';
// Below this descriptor distance we call it the same person.
export const MATCH_THRESHOLD = 0.55;

async function getFaceApi(): Promise<FaceApi> {
  if (!faceapiPromise) {
    faceapiPromise = import('@vladmandic/face-api');
  }
  return faceapiPromise;
}

/** Load the three model nets once. Safe to call repeatedly. */
export async function loadModels(): Promise<void> {
  if (modelsLoaded) return;
  const faceapi = await getFaceApi();
  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ]);
  modelsLoaded = true;
}

function detectorOptions(faceapi: FaceApi) {
  // minConfidence kept low so background / non-frontal faces still register.
  return new faceapi.SsdMobilenetv1Options({ minConfidence: 0.35, maxResults: 20 });
}

function toDetected(d: any): DetectedFace {
  const box = d.detection.box;
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    landmarks: d.landmarks.positions.map((p: any) => ({ x: p.x, y: p.y })),
    descriptor: d.descriptor,
  };
}

/** Single strongest face + descriptor (used for the target portrait). */
export async function describeFace(
  input: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
): Promise<DetectedFace | null> {
  const faceapi = await getFaceApi();
  await loadModels();
  const d = await faceapi
    .detectSingleFace(input as any, detectorOptions(faceapi))
    .withFaceLandmarks()
    .withFaceDescriptor();
  return d ? toDetected(d) : null;
}

/** All faces + descriptors (used for the match media: selfie / video frame). */
export async function describeAllFaces(
  input: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
): Promise<DetectedFace[]> {
  const faceapi = await getFaceApi();
  await loadModels();
  const all = await faceapi
    .detectAllFaces(input as any, detectorOptions(faceapi))
    .withFaceLandmarks()
    .withFaceDescriptors();
  return all.map(toDetected);
}

function euclidean(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Distance → a friendly 0..1 confidence (0.55 distance ≈ 0.45 conf). */
export function distanceToConfidence(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance));
}

/** Find which detected face best matches the target descriptor. */
export function matchAgainst(target: Float32Array, faces: DetectedFace[]): MatchResult | null {
  let best: MatchResult | null = null;
  for (const face of faces) {
    const distance = euclidean(target, face.descriptor);
    if (!best || distance < best.distance) {
      best = { face, distance, confidence: distanceToConfidence(distance), isMatch: distance < MATCH_THRESHOLD };
    }
  }
  return best;
}
