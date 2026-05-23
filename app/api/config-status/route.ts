import { NextResponse } from 'next/server';

function present(value?: string) {
  return Boolean(value && value.trim());
}

function publicTokenStatus(value?: string) {
  if (!present(value)) return 'missing';
  if (!value?.startsWith('pk.')) return 'present_not_public_pk';
  return 'present_public_pk';
}

export async function GET() {
  return NextResponse.json({
    mapbox: {
      publicToken: publicTokenStatus(process.env.NEXT_PUBLIC_MAPBOX_TOKEN),
      serverToken: present(process.env.MAPBOX_TOKEN),
    },
    supabase: {
      publicUrl: present(process.env.NEXT_PUBLIC_SUPABASE_URL),
      publicAnon: present(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      serviceRole: present(process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
    ai: {
      geminiKeys: [
        process.env.GEMINI_API_KEY,
        process.env.GEMINI_API_KEY_2,
        process.env.GEMINI_API_KEY_3,
        ...(process.env.GEMINI_API_KEYS || '').split(','),
      ].filter((key) => present(key)).length,
      elevenLabsKeys: [
        process.env.ELEVENLABS_API_KEY,
        process.env.ELEVENLABS_API_KEY_2,
        process.env.ELEVENLABS_API_KEY_3,
        process.env.ELEVENLABS_API_KEY_4,
        ...(process.env.ELEVENLABS_API_KEYS || '').split(','),
      ].filter((key) => present(key)).length,
      elevenLabsVoice: present(process.env.ELEVENLABS_VOICE_ID),
      simliApiKey: present(process.env.NEXT_PUBLIC_SIMLI_API_KEY),
      simliFaceId: present(process.env.NEXT_PUBLIC_SIMLI_FACE_ID),
    },
    facebook: {
      enabled: process.env.FACEBOOK_ENABLED !== 'false',
      pageId: present(process.env.FACEBOOK_PAGE_ID),
      pageAccessToken: present(process.env.FACEBOOK_PAGE_ACCESS_TOKEN),
      targetImage: present(process.env.FACEBOOK_TARGET_IMAGE_URL),
    },
    minimax: {
      enabled: process.env.MINIMAX_ENABLED === 'true',
      apiKey: present(process.env.MINIMAX_API_KEY),
      groupId: present(process.env.MINIMAX_GROUP_ID),
      videoModel: process.env.MINIMAX_VIDEO_MODEL || null,
    },
    alerts: {
      resend: present(process.env.RESEND_API_KEY),
      smtp: present(process.env.SMTP_HOST) && present(process.env.SMTP_USER) && present(process.env.SMTP_PASS),
      authorityEmail: present(process.env.AUTHORITY_ALERT_EMAIL),
    },
  });
}
