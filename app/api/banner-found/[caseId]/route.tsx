import { ImageResponse } from 'next/og';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'edge';

function getSupa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function text(value: any, fallback = 'Por confirmar') {
  if (Array.isArray(value)) return value.filter(Boolean).join(', ') || fallback;
  return value ? String(value) : fallback;
}

export async function GET(req: Request, { params }: { params: { caseId: string } }) {
  const db = getSupa();
  if (!db) return new Response('Supabase not configured', { status: 500 });

  const { data: kase } = await db.from('cases').select('*').eq('id', params.caseId).single();
  if (!kase) return new Response('Case not found', { status: 404 });

  // Best match for this case
  const { data: topMatch } = await db
    .from('matches')
    .select('*')
    .eq('case_id', params.caseId)
    .order('confidence', { ascending: false })
    .limit(1)
    .single();

  const desc = kase.description || {};
  const origin = new URL(req.url).origin;
  const name = text(desc.nombre, 'Persona identificada');
  const matchLocation = text(topMatch?.place_label || desc.ultima_ubicacion);
  const confidence = topMatch?.confidence ? `${Math.round(Number(topMatch.confidence) * 100)}%` : '—';

  const portrait = kase.portrait_url ? `${origin}/api/image-proxy?url=${encodeURIComponent(kase.portrait_url)}` : null;
  const matchPhoto = topMatch?.photo_url ? `${origin}/api/image-proxy?url=${encodeURIComponent(topMatch.photo_url)}` : null;

  return new ImageResponse(
    (
      <div
        style={{
          width: '1200px',
          height: '1200px',
          display: 'flex',
          background: '#f4f7f6',
          color: '#0a1f1c',
          fontFamily: 'Inter, Arial, sans-serif',
          position: 'relative',
        }}
      >
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(135deg, #ecfdf5 0%, #d1fae5 55%, #a7f3d0 100%)' }} />
        <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: 18, background: '#047857' }} />

        <div style={{ display: 'flex', flexDirection: 'column', width: 520, height: '100%', padding: '72px 44px 48px', zIndex: 2 }}>
          <div style={{ fontSize: 34, letterSpacing: 8, fontWeight: 900, color: '#047857' }}>ARGUS</div>
          <div style={{ marginTop: 16, fontSize: 92, lineHeight: 0.9, fontWeight: 950, color: '#064e3b' }}>PERSONA ENCONTRADA</div>
          <div style={{ marginTop: 26, fontSize: 30, lineHeight: 1.25, color: '#1f3a35' }}>
            Coincidencia visual identificada por los agentes ARGUS. Pendiente verificación humana de autoridad.
          </div>
          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
            <Info label="NOMBRE" value={name} />
            <Info label="ZONA DEL HALLAZGO" value={matchLocation} />
            <Info label="CONFIANZA IA" value={confidence} />
            <Info label="FUENTE" value={text(topMatch?.source_site || 'pendiente')} />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', padding: '72px 56px 48px 20px', zIndex: 2 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, fontSize: 24, fontWeight: 800, color: '#3e5750' }}>
            <span>CASO</span>
            <span>{params.caseId.slice(0, 8).toUpperCase()}</span>
          </div>

          <div style={{ marginTop: 24, display: 'flex', gap: 20 }}>
            <PhotoCard label="Familia" url={portrait} accent="#047857" />
            <PhotoCard label="Coincidencia" url={matchPhoto} accent="#dc2626" />
          </div>

          <div style={{ marginTop: 34, fontSize: 64, lineHeight: 0.96, fontWeight: 950, color: '#064e3b' }}>{name}</div>

          <div
            style={{
              marginTop: 'auto',
              padding: '22px 26px',
              borderRadius: 18,
              background: '#064e3b',
              color: '#ecfdf5',
              fontSize: 28,
              lineHeight: 1.3,
              fontWeight: 750,
            }}
          >
            Si reconoces a esta persona o tienes información adicional, contacta a la autoridad responsable del caso. Esta alerta no reemplaza la verificación oficial.
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 1200 },
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '16px 18px', borderRadius: 14, background: 'rgba(255,255,255,.82)', border: '1px solid #bbf7d0' }}>
      <div style={{ fontSize: 18, fontWeight: 900, color: '#047857', letterSpacing: 2 }}>{label}</div>
      <div style={{ fontSize: 26, lineHeight: 1.15, fontWeight: 800, color: '#064e3b' }}>{value}</div>
    </div>
  );
}

function PhotoCard({ label, url, accent }: { label: string; url: string | null; accent: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: 280, gap: 10 }}>
      <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 2, color: accent }}>{label.toUpperCase()}</div>
      <div
        style={{
          width: 280,
          height: 340,
          borderRadius: 22,
          overflow: 'hidden',
          border: `6px solid ${accent}`,
          background: '#cbd8d5',
          display: 'flex',
        }}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} width={280} height={340} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 800, color: '#5b6f6a' }}>
            SIN FOTO
          </div>
        )}
      </div>
    </div>
  );
}
