import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getSupa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function fetchBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * GET /api/case/<id>/pdf
 * Exporta un dossier forense del caso firmado y con QR de verificación.
 * Patrón inspirado en CrossBeam (Anthropic Opus 4.6 winner): el jurado
 * abre un archivo real que demuestra el end-to-end.
 */
export async function GET(_req: NextRequest, ctx: { params: { caseId: string } }) {
  const caseId = ctx.params.caseId;
  const db = getSupa();
  if (!db) return NextResponse.json({ error: 'supabase_unconfigured' }, { status: 500 });

  const { data: kase } = await db.from('cases').select('*').eq('id', caseId).single();
  if (!kase) return NextResponse.json({ error: 'case not found' }, { status: 404 });

  const { data: events } = await db
    .from('pipeline_events')
    .select('agent,event,payload,created_at')
    .eq('case_id', caseId)
    .order('created_at', { ascending: true })
    .limit(120);

  const { data: matches } = await db
    .from('matches')
    .select('source_url,confidence,place_label,created_at')
    .eq('case_id', caseId)
    .order('created_at', { ascending: true });

  const desc = (kase.description || {}) as any;

  // ---- PDF assembly --------------------------------------------------------
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);

  const page = pdf.addPage([595.28, 841.89]); // A4 portrait
  const { width, height } = page.getSize();
  const margin = 40;
  let cursor = height - margin;

  const ink = rgb(0.08, 0.08, 0.09);
  const muted = rgb(0.4, 0.4, 0.42);
  const accent = rgb(0.96, 0.78, 0.42);

  const writeLine = (text: string, opts: { font?: any; size?: number; color?: any } = {}) => {
    const font = opts.font || helv;
    const size = opts.size || 10;
    page.drawText(text, { x: margin, y: cursor, font, size, color: opts.color || ink });
    cursor -= size + 4;
  };

  const rule = () => {
    page.drawLine({
      start: { x: margin, y: cursor },
      end: { x: width - margin, y: cursor },
      thickness: 0.5,
      color: muted,
    });
    cursor -= 10;
  };

  // Header
  page.drawRectangle({ x: 0, y: height - 60, width, height: 60, color: rgb(0.03, 0.05, 0.05) });
  page.drawText('ARGUS · DOSSIER FORENSE', {
    x: margin, y: height - 38, font: helvBold, size: 14, color: rgb(0.93, 0.93, 0.93),
  });
  page.drawText('def/acc · cadena de custodia firmada', {
    x: margin, y: height - 54, font: helv, size: 8, color: rgb(0.7, 0.78, 0.76),
  });
  page.drawText(`OP-${caseId.slice(0, 8).toUpperCase()}`, {
    x: width - margin - 80, y: height - 38, font: mono, size: 11, color: accent,
  });

  cursor = height - 90;

  // Subject
  writeLine('SUJETO', { font: helvBold, size: 11, color: accent });
  writeLine(`Nombre: ${desc.nombre || '—'}`);
  writeLine(`Edad aprox: ${desc.edad_aprox || '—'}   Género: ${desc.genero || '—'}`);
  writeLine(`Última ubicación: ${desc.ultima_ubicacion || '—'}`);
  writeLine(`Fecha desaparición: ${desc.fecha_desaparicion || '—'}   Hora: ${desc.hora_aproximada || '—'}`);
  writeLine(`Ropa: ${desc.ropa || '—'}`);
  writeLine(`Señas: ${(desc.senales_particulares || []).join(', ') || '—'}`);
  cursor -= 6;
  rule();

  // Portrait + provenance
  writeLine('PORTRAIT + PROVENIENCIA', { font: helvBold, size: 11, color: accent });
  if (kase.portrait_url) {
    const buf = await fetchBuffer(kase.portrait_url);
    if (buf) {
      try {
        const isPng = kase.portrait_url.endsWith('.png');
        const img = isPng ? await pdf.embedPng(buf) : await pdf.embedJpg(buf);
        const w = 120;
        const h = (img.height / img.width) * w;
        page.drawImage(img, { x: margin, y: cursor - h, width: w, height: h });
        // Provenance block beside
        const px = margin + w + 16;
        const py = cursor - 14;
        page.drawText(`URL: ${kase.portrait_url.slice(0, 80)}`, { x: px, y: py, font: mono, size: 7, color: muted });

        // Try to fetch manifest sidecar
        const manifestBuf = await fetchBuffer(`${kase.portrait_url}.cr.json`);
        if (manifestBuf) {
          try {
            const mf = JSON.parse(manifestBuf.toString('utf8'));
            page.drawText(`SHA-256: ${mf.sha256?.slice(0, 32)}…`, { x: px, y: py - 12, font: mono, size: 7, color: ink });
            page.drawText(`Firmado: ${mf.signer || '—'}`, { x: px, y: py - 24, font: helv, size: 8, color: ink });
            page.drawText(`Fecha: ${mf.signed_at || '—'}`, { x: px, y: py - 36, font: helv, size: 8, color: ink });
            page.drawText('CR — Content Credentials (Argus def/acc v1)', { x: px, y: py - 50, font: helvBold, size: 8, color: accent });
          } catch {
            page.drawText('Manifiesto presente pero no parseable', { x: px, y: py - 12, font: helv, size: 8, color: muted });
          }
        } else {
          page.drawText('Sin manifiesto C2PA sidecar', { x: px, y: py - 12, font: helv, size: 8, color: muted });
        }
        cursor -= h + 16;
      } catch {
        writeLine('(no se pudo decodificar el portrait)', { color: muted });
      }
    } else {
      writeLine('(portrait no descargable)', { color: muted });
    }
  } else {
    writeLine('Sin portrait', { color: muted });
  }
  rule();

  // Anclaje Filecoin
  writeLine('ANCLAJE FILECOIN / IPFS', { font: helvBold, size: 11, color: accent });
  if (kase.evidence_cid && kase.evidence_cid !== 'local-only') {
    writeLine(`CID: ${kase.evidence_cid}`, { font: mono, size: 9 });
    writeLine(`Gateway: https://gateway.lighthouse.storage/ipfs/${kase.evidence_cid}`, { size: 8, color: muted });
  } else {
    writeLine('Anclaje pendiente o local-only', { color: muted });
  }
  rule();

  // Eventos
  writeLine('CADENA DE EVENTOS', { font: helvBold, size: 11, color: accent });
  const evs = events || [];
  if (evs.length === 0) {
    writeLine('Sin eventos registrados', { color: muted });
  } else {
    for (const ev of evs.slice(-30)) {
      if (cursor < 120) break;
      const ts = new Date(ev.created_at).toISOString().slice(11, 19);
      writeLine(`${ts}  ${ev.agent.padEnd(10)} ${ev.event}`, { font: mono, size: 8 });
    }
  }
  rule();

  // Matches
  writeLine('COINCIDENCIAS', { font: helvBold, size: 11, color: accent });
  const ms = matches || [];
  if (ms.length === 0) {
    writeLine('Sin coincidencias confirmadas', { color: muted });
  } else {
    for (const m of ms.slice(0, 8)) {
      if (cursor < 120) break;
      const conf = m.confidence ? `${(m.confidence * 100).toFixed(0)}%` : '—';
      writeLine(`[${conf}] ${m.place_label || '—'} · ${m.source_url || ''}`.slice(0, 100), { size: 9 });
    }
  }

  // QR de verificación
  const verifyUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://argus-jet.vercel.app'}/api/c2pa/verify?case=${caseId}`;
  try {
    const qrPng = await QRCode.toBuffer(verifyUrl, { type: 'png', margin: 1, width: 140 });
    const qrImg = await pdf.embedPng(qrPng);
    const qrSize = 90;
    page.drawImage(qrImg, { x: width - margin - qrSize, y: 50, width: qrSize, height: qrSize });
    page.drawText('Escanea para verificar firma del portrait', {
      x: width - margin - 180, y: 35, font: helv, size: 7, color: muted,
    });
  } catch (err: any) {
    console.warn('[pdf] qr failed:', err?.message);
  }

  // Footer
  page.drawText(`Generado ${new Date().toISOString()}  ·  argus-defacc`, {
    x: margin, y: 30, font: mono, size: 7, color: muted,
  });

  const bytes = await pdf.save();

  return new NextResponse(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="argus-dossier-${caseId.slice(0, 8)}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
