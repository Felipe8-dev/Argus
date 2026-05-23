'use client';

import { useEffect, useState } from 'react';

interface Props {
  caseId: string | null;
  evidenceCid?: string | null;
}

function trunc(s: string, head = 6, tail = 4) {
  if (s.length < head + tail + 2) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export default function AnchorPill({ caseId, evidenceCid }: Props) {
  const [cid, setCid] = useState<string | null>(evidenceCid ?? null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setCid(evidenceCid ?? null);
  }, [evidenceCid]);

  const triggerAnchor = async () => {
    if (!caseId || pending) return;
    setPending(true);
    try {
      const r = await fetch('/api/case/anchor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId }),
      });
      const json = await r.json();
      if (json.ok && json.anchor?.cid && json.anchor.cid !== 'local-only') {
        setCid(json.anchor.cid);
      }
    } finally {
      setPending(false);
    }
  };

  if (!cid || cid === 'local-only') {
    return (
      <button
        type="button"
        className="anchor-pill anchor-pending"
        onClick={triggerAnchor}
        disabled={!caseId || pending}
        title="Click para anclar este caso en Filecoin"
      >
        <span className="anchor-mark">⌬</span>
        <span>{pending ? 'anclando…' : 'anclar Filecoin'}</span>
      </button>
    );
  }

  return (
    <a
      href={`https://gateway.lighthouse.storage/ipfs/${cid}`}
      target="_blank"
      rel="noreferrer"
      className="anchor-pill anchor-ok"
      title={`CID Filecoin: ${cid} · click para ver manifest público`}
    >
      <span className="anchor-mark">⌬</span>
      <span>Filecoin · {trunc(cid)}</span>
    </a>
  );
}
