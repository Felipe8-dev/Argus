import { NextRequest, NextResponse } from 'next/server';
import { AccessToken } from 'livekit-server-sdk';

/**
 * Mints a short-lived LiveKit access token so the browser can join a room.
 *
 * One room per intake session (`argus-<caseId|nanoid>`). The conversational
 * agent worker (see `agent-worker/`) joins the same room and handles
 * STT → LLM → TTS; the browser publishes the family's mic and plays the
 * agent's audio, while Simli renders the avatar from the same audio track.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL || process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !wsUrl) {
    return NextResponse.json(
      { error: 'LiveKit not configured (set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, NEXT_PUBLIC_LIVEKIT_URL)' },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const caseId: string | undefined = body?.caseId;
  const identity: string = body?.identity || `family-${Math.random().toString(36).slice(2, 10)}`;
  const room = caseId ? `argus-${caseId}` : `argus-${Math.random().toString(36).slice(2, 12)}`;

  const at = new AccessToken(apiKey, apiSecret, { identity, ttl: '15m' });
  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const token = await at.toJwt();
  return NextResponse.json({ token, url: wsUrl, room, identity });
}
