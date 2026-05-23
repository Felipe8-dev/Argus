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

export async function GET(_req: Request, { params }: { params: { caseId: string } }) {
  const db = getSupa();
  if (!db) return new Response('Supabase not configured', { status: 500 });

  const { data: kase } = await db.from('cases').select('*').eq('id', params.caseId).single();
  if (!kase) return new Response('Case not found', { status: 404 });

  const desc = kase.description || {};
  const name = text(desc.nombre, 'Persona por identificar');
  const age = desc.edad_aprox ? `${desc.edad_aprox} anos` : 'Edad por confirmar';
  const location = text(desc.ultima_ubicacion);
  const date = [desc.fecha_desaparicion, desc.hora_aproximada].filter(Boolean).join(' - ') || 'Fecha/hora por confirmar';
  const clothing = text(desc.ropa);
  const signs = text(desc.senales_particulares);
  const origin = new URL(_req.url).origin;
  const photo = kase.portrait_url ? `${origin}/api/image-proxy?url=${encodeURIComponent(kase.portrait_url)}` : null;

  return new ImageResponse(
    (
      <div
        style={{
          width: '1200px',
          height: '1200px',
          display: 'flex',
          background: '#f4f7f6',
          color: '#111c1a',
          fontFamily: 'Inter, Arial, sans-serif',
          position: 'relative',
        }}
      >
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(135deg, #ffffff 0%, #edf4f1 52%, #dbe8e3 100%)' }} />
        <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: 18, background: '#b91c1c' }} />
        <div style={{ display: 'flex', flexDirection: 'column', width: 520, height: '100%', padding: '72px 44px 48px', zIndex: 2 }}>
          <div style={{ fontSize: 34, letterSpacing: 8, fontWeight: 900, color: '#b91c1c' }}>ARGUS</div>
          <div style={{ marginTop: 16, fontSize: 82, lineHeight: 0.9, fontWeight: 950, color: '#101b19' }}>ALERTA DE BUSQUEDA</div>
          <div style={{ marginTop: 26, fontSize: 32, lineHeight: 1.2, color: '#34413e' }}>Respuesta temprana civil. Informacion para validacion humana y patrullaje preventivo.</div>
          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
            <Info label="ULTIMO LUGAR VISTO" value={location} />
            <Info label="FECHA / HORA" value={date} />
            <Info label="ROPA" value={clothing} />
            <Info label="SENAS" value={signs} />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', padding: '72px 56px 48px 20px', zIndex: 2 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, fontSize: 24, fontWeight: 800, color: '#63736f' }}>
            <span>CASO</span>
            <span>{params.caseId.slice(0, 8).toUpperCase()}</span>
          </div>
          <div style={{ marginTop: 24, width: 560, height: 620, borderRadius: 24, overflow: 'hidden', border: '10px solid white', boxShadow: '0 24px 60px rgba(17,28,26,.22)', background: '#cbd8d5', display: 'flex' }}>
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photo} alt={name} width={560} height={620} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 42, fontWeight: 800, color: '#63736f' }}>SIN FOTO</div>
            )}
          </div>
          <div style={{ marginTop: 34, fontSize: 72, lineHeight: 0.96, fontWeight: 950, color: '#101b19' }}>{name}</div>
          <div style={{ marginTop: 10, fontSize: 42, fontWeight: 850, color: '#b91c1c' }}>{age}</div>
          <div style={{ marginTop: 'auto', padding: '22px 26px', borderRadius: 18, background: '#101b19', color: '#f8fffd', fontSize: 30, lineHeight: 1.25, fontWeight: 750 }}>
            Si tienes informacion, contacta a las autoridades o responde al canal de alerta ARGUS.
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 1200 },
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '16px 18px', borderRadius: 14, background: 'rgba(255,255,255,.78)', border: '1px solid #d8e4df' }}>
      <div style={{ fontSize: 18, fontWeight: 900, color: '#b91c1c', letterSpacing: 2 }}>{label}</div>
      <div style={{ fontSize: 28, lineHeight: 1.1, fontWeight: 800, color: '#101b19' }}>{value}</div>
    </div>
  );
}
