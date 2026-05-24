// Copies the face-api model weights we use from the @vladmandic/face-api
// package into public/models so the browser can load them from /models.
//
// Kept out of git (see .gitignore) and regenerated on every install via the
// "postinstall" npm script — the weights live in the dependency, not the repo.
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@vladmandic', 'face-api', 'model');
const dst = join(root, 'public', 'models');

const MODELS = ['ssd_mobilenetv1', 'tiny_face_detector', 'face_landmark_68', 'face_recognition'];

if (!existsSync(src)) {
  console.warn('[copy-face-models] @vladmandic/face-api/model not found — skipping (install deps first).');
  process.exit(0);
}

mkdirSync(dst, { recursive: true });
let copied = 0;
for (const m of MODELS) {
  for (const f of [`${m}_model.bin`, `${m}_model-weights_manifest.json`]) {
    const from = join(src, f);
    if (existsSync(from)) {
      copyFileSync(from, join(dst, f));
      copied++;
    } else {
      console.warn(`[copy-face-models] missing ${f}`);
    }
  }
}
console.log(`[copy-face-models] copied ${copied} files → public/models`);
