/**
 * Lightweight C2PA-inspired provenance (Argus def/acc).
 *
 * No depende de la SDK nativa de @contentauth/c2pa-node (que requiere
 * binarios nativos en el runtime de Vercel). En su lugar firmamos un
 * manifiesto JSON sidecar con ed25519 + SHA-256, lo cual nos da las
 * mismas propiedades verificables que un C2PA básico:
 *
 *   - integridad del binario (sha256 del archivo)
 *   - autoría firmada criptográficamente (ed25519)
 *   - metadata declarativa firmada (caseId, timestamp, claims)
 *   - verificable offline por cualquier tercero con la public key
 *
 * El badge visible en UI dice "CR" (Content Credentials) reusando el
 * lenguaje del estándar real; en código documentamos honestamente que
 * es un manifiesto custom inspirado en C2PA, no spec-compliant.
 *
 * Para producción real: migrar a c2pa-rs vía WASM y registrar un cert
 * real (Adobe / Truepic / etc.). Para el demo de hackathon basta esto.
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

export const MANIFEST_VERSION = 'argus-c2pa-v1';
const KEYS_DIR = path.join(process.cwd(), '.c2pa-keys');

interface KeyPair {
  privatePem: string;
  publicPem: string;
}

let cachedKeyPair: KeyPair | null = null;

async function loadOrCreateKeys(): Promise<KeyPair> {
  if (cachedKeyPair) return cachedKeyPair;

  const fromEnvPriv = process.env.C2PA_SIGN_KEY_PRIVATE_PEM;
  const fromEnvPub = process.env.C2PA_SIGN_KEY_PUBLIC_PEM;
  if (fromEnvPriv && fromEnvPub) {
    cachedKeyPair = { privatePem: fromEnvPriv, publicPem: fromEnvPub };
    return cachedKeyPair;
  }

  try {
    const priv = await fs.readFile(path.join(KEYS_DIR, 'private.pem'), 'utf8');
    const pub = await fs.readFile(path.join(KEYS_DIR, 'public.pem'), 'utf8');
    cachedKeyPair = { privatePem: priv, publicPem: pub };
    return cachedKeyPair;
  } catch {
    // generate ephemeral pair
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

  try {
    await fs.mkdir(KEYS_DIR, { recursive: true });
    await fs.writeFile(path.join(KEYS_DIR, 'private.pem'), privatePem, { mode: 0o600 });
    await fs.writeFile(path.join(KEYS_DIR, 'public.pem'), publicPem);
  } catch (err: any) {
    console.warn('[c2pa] could not persist ephemeral keys:', err?.message);
  }

  cachedKeyPair = { privatePem, publicPem };
  return cachedKeyPair;
}

export interface ProvenanceClaims {
  caseId?: string | null;
  publishedBy?: string;
  purpose?: 'portrait_intake' | 'banner_publish' | 'banner_found' | 'evidence';
  notes?: string;
  source?: string;
}

export interface SignedManifest {
  version: typeof MANIFEST_VERSION;
  sha256: string;
  signed_at: string;
  signer: string;
  claims: ProvenanceClaims;
  signature: string;
  public_key_pem: string;
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function signImage(
  buffer: Buffer,
  claims: ProvenanceClaims = {},
): Promise<{ signedBuffer: Buffer; manifest: SignedManifest }> {
  const { privatePem, publicPem } = await loadOrCreateKeys();

  const hash = sha256(buffer);
  const signedAt = new Date().toISOString();
  const signer = process.env.C2PA_SIGNER_LABEL || 'ARGUS def/acc';

  const payload = JSON.stringify({
    version: MANIFEST_VERSION,
    sha256: hash,
    signed_at: signedAt,
    signer,
    claims,
  });

  const signature = crypto.sign(null, Buffer.from(payload), privatePem).toString('base64');

  const manifest: SignedManifest = {
    version: MANIFEST_VERSION,
    sha256: hash,
    signed_at: signedAt,
    signer,
    claims,
    signature,
    public_key_pem: publicPem,
  };

  // signedBuffer = original buffer; the manifest lives as sidecar.
  // (a future iteration could embed JUMBF in JPEG APP11 markers)
  return { signedBuffer: buffer, manifest };
}

export function verifyManifest(buffer: Buffer, manifest: SignedManifest): {
  valid: boolean;
  reason?: string;
} {
  try {
    if (manifest.version !== MANIFEST_VERSION) {
      return { valid: false, reason: 'version mismatch' };
    }
    const actualHash = sha256(buffer);
    if (actualHash !== manifest.sha256) {
      return { valid: false, reason: 'sha256 mismatch — image tampered' };
    }
    const payload = JSON.stringify({
      version: manifest.version,
      sha256: manifest.sha256,
      signed_at: manifest.signed_at,
      signer: manifest.signer,
      claims: manifest.claims,
    });
    const sigBuf = Buffer.from(manifest.signature, 'base64');
    const ok = crypto.verify(null, Buffer.from(payload), manifest.public_key_pem, sigBuf);
    return ok ? { valid: true } : { valid: false, reason: 'signature invalid' };
  } catch (err: any) {
    return { valid: false, reason: err?.message || 'verify error' };
  }
}

export async function manifestSidecarPath(originalPath: string): Promise<string> {
  return `${originalPath}.cr.json`;
}

export function manifestPublicSummary(manifest: SignedManifest) {
  return {
    cr: 'argus-c2pa-v1',
    sha256: manifest.sha256.slice(0, 16) + '…',
    signer: manifest.signer,
    signed_at: manifest.signed_at,
    purpose: manifest.claims.purpose || 'evidence',
  };
}
