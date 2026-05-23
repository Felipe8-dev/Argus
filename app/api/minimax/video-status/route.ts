import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const apiKey = process.env.MINIMAX_API_KEY;
  const taskId = req.nextUrl.searchParams.get('task_id');
  if (!apiKey) return NextResponse.json({ ok: false, error: 'MINIMAX_API_KEY missing' }, { status: 500 });
  if (!taskId) return NextResponse.json({ ok: false, error: 'task_id missing' }, { status: 400 });

  const statusRes = await fetch(`https://api.minimax.io/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const status = await statusRes.json().catch(() => ({}));

  if (!statusRes.ok || status.status !== 'Success' || !status.file_id) {
    return NextResponse.json({ ok: statusRes.ok, status });
  }

  const fileRes = await fetch(`https://api.minimax.io/v1/files/retrieve?file_id=${encodeURIComponent(status.file_id)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const file = await fileRes.json().catch(() => ({}));

  return NextResponse.json({
    ok: fileRes.ok,
    status,
    file,
    download_url: file.file?.download_url || null,
  });
}
