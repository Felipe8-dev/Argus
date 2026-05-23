import { NextRequest, NextResponse } from 'next/server';
import nodemailer from 'nodemailer';

type AlertKind = 'alert' | 'found';

interface AlertPayload {
  caseId?: string;
  authorityEmail?: string;
  description?: Record<string, any>;
  match?: Record<string, any>;
  photoUrl?: string;
  bannerUrl?: string;
  mapUrl?: string;
  kind?: AlertKind;
}

function escape(value: any) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function buildAlertHtml(payload: AlertPayload) {
  const description = payload.description || {};
  const match = payload.match || {};
  const rows: Array<[string, string]> = [
    ['Caso', payload.caseId || 'ARGUS-DEMO'],
    ['Nombre', description.nombre || 'Por confirmar'],
    ['Edad', description.edad_aprox ? `${description.edad_aprox} años` : 'Por confirmar'],
    ['Ultima ubicacion', description.ultima_ubicacion || 'Por confirmar'],
    ['Fecha / hora', [description.fecha_desaparicion, description.hora_aproximada].filter(Boolean).join(' - ') || 'Por confirmar'],
    ['Ropa', description.ropa || 'Por confirmar'],
    ['Senales', Array.isArray(description.senales_particulares) ? description.senales_particulares.join(', ') : 'Por confirmar'],
    ['Posible encuentro', match.place_label || match.location || 'Zona priorizada por ARGUS'],
    ['Confianza', match.confidence ? `${Math.round(Number(match.confidence) * 100)}%` : 'En revision'],
  ];

  return `
    <div style="font-family:Inter,Arial,sans-serif;background:#f4f7f6;padding:24px;color:#111c1a">
      <div style="max-width:640px;margin:auto;background:#fff;border:1px solid #d8e1de;border-radius:8px;overflow:hidden">
        ${payload.bannerUrl ? `<img src="${escape(payload.bannerUrl)}" alt="Banner ARGUS" style="display:block;width:100%;height:auto;border-bottom:1px solid #d8e1de" />` : ''}
        <div style="background:#101b19;color:white;padding:18px 22px">
          <h1 style="margin:0;font-size:20px">ARGUS - Alerta de patrullaje</h1>
          <p style="margin:6px 0 0;color:#cbd8d5">Se recomienda reforzar patrullaje preventivo, revisar camaras cercanas y validar reportes ciudadanos en la zona indicada.</p>
        </div>
        ${payload.photoUrl ? `<div style="padding:16px 16px 0"><img src="${escape(payload.photoUrl)}" alt="Foto de referencia" style="display:block;width:100%;max-height:360px;object-fit:cover;border-radius:8px;border:1px solid #d8e1de" /></div>` : ''}
        <table style="width:100%;border-collapse:collapse">
          ${rows.map(([label, value]) => `
            <tr>
              <td style="width:190px;padding:12px 16px;border-bottom:1px solid #edf1ef;color:#63736f;font-weight:700">${escape(label)}</td>
              <td style="padding:12px 16px;border-bottom:1px solid #edf1ef">${escape(value)}</td>
            </tr>
          `).join('')}
        </table>
        <div style="padding:16px 18px 20px;background:#f7faf9;color:#31413d;font-size:14px;line-height:1.5">
          <strong>Accion sugerida:</strong> reforzar presencia visible en el ultimo lugar visto, consultar camaras privadas/publicas y mantener contacto con la familia. Esta alerta no reemplaza verificacion oficial.
          ${payload.mapUrl ? `<br/><br/><a href="${escape(payload.mapUrl)}" style="color:#0f766e;font-weight:700">Abrir ubicacion priorizada</a>` : ''}
        </div>
      </div>
    </div>
  `;
}

function buildFoundHtml(payload: AlertPayload) {
  const description = payload.description || {};
  const match = payload.match || {};
  const rows: Array<[string, string]> = [
    ['Caso', payload.caseId || 'ARGUS-DEMO'],
    ['Nombre', description.nombre || 'Por confirmar'],
    ['Edad', description.edad_aprox ? `${description.edad_aprox} años` : 'Por confirmar'],
    ['Zona del hallazgo', match.place_label || 'Por confirmar'],
    ['Fuente', match.source_site || 'Fuente publica'],
    ['Confianza IA', match.confidence ? `${Math.round(Number(match.confidence) * 100)}%` : 'En revision'],
  ];

  return `
    <div style="font-family:Inter,Arial,sans-serif;background:#ecfdf5;padding:24px;color:#064e3b">
      <div style="max-width:640px;margin:auto;background:#fff;border:1px solid #bbf7d0;border-radius:10px;overflow:hidden">
        ${payload.bannerUrl ? `<img src="${escape(payload.bannerUrl)}" alt="Banner ENCONTRADO" style="display:block;width:100%;height:auto;border-bottom:1px solid #bbf7d0" />` : ''}
        <div style="background:#047857;color:white;padding:20px 22px">
          <h1 style="margin:0;font-size:22px">ARGUS - Posible coincidencia identificada</h1>
          <p style="margin:8px 0 0;color:#d1fae5">El sistema detecto una coincidencia visual con alta confianza. Requiere verificacion humana antes de cualquier accion oficial.</p>
        </div>
        ${payload.photoUrl || match.photo_url ? `
          <div style="display:flex;gap:12px;padding:18px 16px 0">
            ${payload.photoUrl ? `<div style="flex:1"><div style="font-size:12px;font-weight:700;color:#047857;margin-bottom:6px">FAMILIA</div><img src="${escape(payload.photoUrl)}" alt="Retrato" style="width:100%;height:240px;object-fit:cover;border-radius:8px;border:2px solid #047857" /></div>` : ''}
            ${match.photo_url ? `<div style="flex:1"><div style="font-size:12px;font-weight:700;color:#b91c1c;margin-bottom:6px">COINCIDENCIA</div><img src="${escape(match.photo_url)}" alt="Match" style="width:100%;height:240px;object-fit:cover;border-radius:8px;border:2px solid #dc2626" /></div>` : ''}
          </div>` : ''}
        <table style="width:100%;border-collapse:collapse;margin-top:16px">
          ${rows.map(([label, value]) => `
            <tr>
              <td style="width:190px;padding:12px 16px;border-bottom:1px solid #d1fae5;color:#3e5750;font-weight:700">${escape(label)}</td>
              <td style="padding:12px 16px;border-bottom:1px solid #d1fae5">${escape(value)}</td>
            </tr>
          `).join('')}
        </table>
        <div style="padding:16px 18px 22px;background:#f0fdf4;color:#064e3b;font-size:14px;line-height:1.5">
          <strong>Accion sugerida:</strong> verificar fisicamente la zona del hallazgo, contactar a la fuente publica reportada y coordinar con la familia para confirmacion. Esta alerta NO reemplaza verificacion oficial.
          ${payload.mapUrl ? `<br/><br/><a href="${escape(payload.mapUrl)}" style="color:#047857;font-weight:700">Abrir ubicacion del hallazgo</a>` : ''}
          ${match.source_url ? `<br/><a href="${escape(match.source_url)}" style="color:#047857;font-weight:700">Abrir fuente original</a>` : ''}
        </div>
      </div>
    </div>
  `;
}

function buildEmailHtml(payload: AlertPayload) {
  return payload.kind === 'found' ? buildFoundHtml(payload) : buildAlertHtml(payload);
}

export async function POST(req: NextRequest) {
  const payload = await req.json() as AlertPayload;
  const to = payload.authorityEmail || process.env.AUTHORITY_ALERT_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;
  const subject = payload.kind === 'found'
    ? `ARGUS - Posible coincidencia identificada para caso ${payload.caseId || 'demo'}`
    : `ARGUS - Alerta ${payload.caseId || 'demo'} para patrullaje`;
  const html = buildEmailHtml(payload);

  if (!to) {
    return NextResponse.json({ error: 'No authority email configured' }, { status: 400 });
  }

  if (!apiKey) {
    const smtpResult = await sendSmtpAlert(to, subject, html);
    if (smtpResult) return NextResponse.json({ ok: true, to, data: smtpResult });

    return NextResponse.json({
      ok: true,
      simulated: true,
      to,
      message: 'No hay RESEND_API_KEY ni SMTP configurado. Alerta simulada para demo local.',
    });
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'ARGUS <onboarding@resend.dev>',
      to,
      subject,
      html,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const smtpResult = await sendSmtpAlert(to, subject, html);
    if (smtpResult) return NextResponse.json({ ok: true, to, data: smtpResult, resendFallback: data });

    return NextResponse.json({ error: 'Resend failed', details: data }, { status: response.status });
  }

  return NextResponse.json({ ok: true, to, data });
}

async function sendSmtpAlert(to: string, subject: string, html: string) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE !== 'false',
    auth: { user, pass },
  });

  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || `ARGUS <${user}>`,
    to,
    subject,
    html,
  });

  return {
    provider: 'smtp',
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
  };
}
