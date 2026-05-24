'use client';

import { useEffect, useRef, useState } from 'react';

interface Post {
  at: string;
  did: string;
  handle?: string;
  text: string;
  uri: string;
  lang?: string;
  reason?: string;
  source: 'live' | 'historical' | 'system';
  permalink?: string;
}

function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

function buildPermalink(post: Post): string | null {
  if (post.permalink) return post.permalink;
  if (!post.uri || !post.did) return null;
  const rkey = post.uri.split('/').pop();
  if (!rkey) return null;
  return `https://bsky.app/profile/${post.did}/post/${rkey}`;
}

export default function BlueskyTicker({ caseId }: { caseId: string | null }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [connected, setConnected] = useState(false);
  const [min, setMin] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!caseId) return;
    const url = `/api/bluesky-stream?caseId=${encodeURIComponent(caseId)}`;
    const es = new EventSource(url);
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      try {
        const p = JSON.parse(ev.data) as Post;
        if (p.source === 'system') return; // initial hello only
        setPosts((prev) => [p, ...prev].slice(0, 12));
      } catch {}
    };
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [caseId]);

  if (!caseId) return null;

  return (
    <aside className={`bsky-ticker minw${min ? ' is-min' : ''}`}>
      <button className="minw-btn" onClick={() => setMin((v) => !v)} title={min ? 'Expandir' : 'Minimizar'}>
        {min ? '+' : '–'}
      </button>
      <span className="minw-label">Señal social</span>
      <header className="bsky-head">
        <div>
          <span className="bsky-kicker">señal social · live</span>
          <h4>Bluesky firehose</h4>
        </div>
        <span className={`bsky-dot ${connected ? 'on' : 'off'}`} />
      </header>
      {posts.length === 0 ? (
        <p className="bsky-empty">Escuchando red AT-Proto… (puede tardar)</p>
      ) : (
        <ul className="bsky-list">
          {posts.map((p, i) => {
            const permalink = buildPermalink(p);
            return (
              <li key={`${p.uri || i}-${p.at}`} className={`bsky-item bsky-${p.source}`}>
                <div className="bsky-meta">
                  <span className="bsky-handle">@{p.handle || p.did.slice(0, 12)}…</span>
                  <span className="bsky-time">{timeAgo(p.at)}</span>
                  {p.source === 'historical' && <span className="bsky-tag">histórico</span>}
                </div>
                <p className="bsky-text">{p.text.slice(0, 200)}</p>
                {p.reason && <span className="bsky-reason">match: {p.reason}</span>}
                {permalink && (
                  <a href={permalink} target="_blank" rel="noreferrer" className="bsky-link">abrir →</a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
