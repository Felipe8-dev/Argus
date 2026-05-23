'use client';

import { useEffect, useState } from 'react';

interface Props {
  caseId: string | null;
}

interface VerifyResponse {
  ok: boolean;
  verdict?: { valid: boolean; reason?: string };
  manifest?: any;
  manifest_url?: string;
  portrait_url?: string;
}

export default function ProvenancePill({ caseId }: Props) {
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'fail' | 'no_manifest'>('idle');
  const [data, setData] = useState<VerifyResponse | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!caseId) return;
    setState('loading');
    fetch(`/api/c2pa/verify?case=${encodeURIComponent(caseId)}`)
      .then(async (r) => {
        const json: VerifyResponse = await r.json();
        if (!r.ok) {
          setState(json.verdict?.reason?.includes('no manifest') ? 'no_manifest' : 'fail');
          setData(json);
          return;
        }
        setData(json);
        setState(json.verdict?.valid ? 'ok' : 'fail');
      })
      .catch(() => setState('fail'));
  }, [caseId]);

  if (!caseId || state === 'idle' || state === 'loading') {
    return (
      <span className="cr-pill cr-loading" title="Verificando proveniencia…">
        <span className="cr-mark">CR</span>
        <span className="cr-text">verificando…</span>
      </span>
    );
  }

  if (state === 'no_manifest') {
    return (
      <span className="cr-pill cr-pending" title="No hay manifiesto C2PA sidecar">
        <span className="cr-mark">CR</span>
        <span className="cr-text">sin firma</span>
      </span>
    );
  }

  const ok = state === 'ok';
  const sha = data?.manifest?.sha256 || '';

  return (
    <>
      <button
        type="button"
        className={`cr-pill ${ok ? 'cr-ok' : 'cr-fail'}`}
        onClick={() => setOpen(true)}
        title={ok ? `Firmado ${data?.manifest?.signed_at}` : `No verificado: ${data?.verdict?.reason}`}
      >
        <span className="cr-mark">CR</span>
        <span className="cr-text">{ok ? 'firmado' : 'no verifica'}</span>
        {sha && <span className="cr-sha">{sha.slice(0, 6)}…</span>}
      </button>
      {open && (
        <div className="cr-modal-backdrop" onClick={() => setOpen(false)}>
          <div className="cr-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <div>
                <span className="cr-kicker">Content Credentials · argus-c2pa-v1</span>
                <h3>{ok ? 'Firma verificada' : 'Firma no verifica'}</h3>
              </div>
              <button onClick={() => setOpen(false)}>×</button>
            </header>
            <dl className="cr-fields">
              <div><dt>SHA-256</dt><dd>{sha || '—'}</dd></div>
              <div><dt>Firmante</dt><dd>{data?.manifest?.signer || '—'}</dd></div>
              <div><dt>Fecha</dt><dd>{data?.manifest?.signed_at || '—'}</dd></div>
              <div><dt>Propósito</dt><dd>{data?.manifest?.claims?.purpose || '—'}</dd></div>
              {!ok && data?.verdict?.reason && (
                <div><dt>Motivo</dt><dd className="cr-bad">{data.verdict.reason}</dd></div>
              )}
            </dl>
            <pre className="cr-json">{JSON.stringify(data?.manifest || {}, null, 2)}</pre>
            {data?.portrait_url && (
              <p className="cr-foot">
                Verificable también en /api/c2pa/verify?case={caseId}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
