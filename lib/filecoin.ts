/**
 * Lighthouse / Filecoin tamper-proof case anchoring.
 *
 * Sube un manifiesto JSON del caso a IPFS via Lighthouse y devuelve el CID.
 * El CID es permanente y verificable por cualquier nodo IPFS o gateway
 * público. Esto responde la pregunta más dura del jurado def/acc:
 * "¿cómo evitan que alguien manipule la evidencia después?".
 *
 * Plan free: 5 GB. Key en https://files.lighthouse.storage/ → Settings.
 *
 * Falla suave: si LIGHTHOUSE_API_KEY no está configurada el anclaje
 * devuelve { cid: 'local-only', url: null } y la pipeline sigue. La UI
 * muestra "anclaje pendiente" en gris para que el operador lo note.
 */

export interface CaseAnchorManifest {
  version: 'argus-filecoin-v1';
  caseId: string;
  subject_name?: string | null;
  last_seen_zone?: string | null;
  last_seen_at?: string | null;
  portrait_sha256?: string | null;
  provenance_summary?: any;
  events?: Array<{ agent: string; event: string; at: string }>;
  anchored_at: string;
}

export interface AnchorResult {
  cid: string;
  url: string | null;
  size?: number;
  configured: boolean;
}

export const LIGHTHOUSE_GATEWAY = 'https://gateway.lighthouse.storage/ipfs';

export async function anchorCase(manifest: CaseAnchorManifest): Promise<AnchorResult> {
  const key = process.env.LIGHTHOUSE_API_KEY;
  if (!key) {
    console.warn('[filecoin] LIGHTHOUSE_API_KEY not set — skipping anchor');
    return { cid: 'local-only', url: null, configured: false };
  }

  const body = new FormData();
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
  body.append('file', blob, `case-${manifest.caseId}.json`);

  try {
    const res = await fetch('https://node.lighthouse.storage/api/v0/add', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body,
    });
    if (!res.ok) {
      console.error('[filecoin] lighthouse upload failed:', res.status, await res.text().catch(() => ''));
      return { cid: 'local-only', url: null, configured: true };
    }
    // Lighthouse responds with NDJSON: each line `{"Name":"…","Hash":"…","Size":"…"}`
    const text = await res.text();
    const last = text.trim().split('\n').filter(Boolean).pop() || '{}';
    const parsed = JSON.parse(last);
    const cid = parsed.Hash || parsed.cid || '';
    if (!cid) return { cid: 'local-only', url: null, configured: true };
    return {
      cid,
      url: `${LIGHTHOUSE_GATEWAY}/${cid}`,
      size: Number(parsed.Size) || 0,
      configured: true,
    };
  } catch (err: any) {
    console.error('[filecoin] anchor error:', err?.message);
    return { cid: 'local-only', url: null, configured: true };
  }
}

export async function fetchAnchor(cid: string): Promise<CaseAnchorManifest | null> {
  if (cid === 'local-only') return null;
  try {
    const res = await fetch(`${LIGHTHOUSE_GATEWAY}/${cid}`);
    if (!res.ok) return null;
    return (await res.json()) as CaseAnchorManifest;
  } catch {
    return null;
  }
}

export function truncateCid(cid: string, head = 6, tail = 4): string {
  if (!cid || cid.length < head + tail + 2) return cid;
  return `${cid.slice(0, head)}…${cid.slice(-tail)}`;
}
