// Facebook Graph API publisher. Tries 3 strategies in order:
//   1. download the image ourselves, POST as multipart (works on localhost)
//   2. let Facebook fetch a publicly-reachable URL
//   3. text-only post as a last resort
// Returns a structured result that's logged into pipeline_events.

export interface FacebookPublishResult {
  enabled: boolean;
  ok?: boolean;
  reason?: string;
  via?: 'banner_binary' | 'url_fetch' | 'text_only';
  id?: string;
  source?: string;
  raw?: any;
  status?: number;
  error?: string;
  error_code?: number;
  code?: number;
  subcode?: number;
  type?: string;
  expired?: boolean;
  deprecated_permission?: boolean;
  attempts?: Array<{ source: string; kind: 'binary' | 'url' }>;
}

function classifyFacebookError(data: any, response: Response) {
  if (data?.error?.code === 190 || data?.error?.error_subcode === 463) {
    return {
      ok: false as const,
      error: 'Facebook token expired - regenerate at developers.facebook.com',
      error_code: data.error.code,
      type: data.error.type,
      expired: true,
    };
  }
  if (data?.error?.message?.includes('publish_actions') || data?.error?.code === 200) {
    return {
      ok: false as const,
      error: 'Facebook permission missing. Request pages_manage_posts + photo_upload on the page token.',
      error_code: data.error.code,
      type: data.error.type,
      deprecated_permission: true,
    };
  }
  if (!response.ok) {
    return {
      ok: false as const,
      status: response.status,
      error: data?.error?.message || 'Facebook publish failed',
      type: data?.error?.type,
      code: data?.error?.code,
      subcode: data?.error?.error_subcode,
    };
  }
  return null;
}

async function fetchImageBlob(url: string): Promise<{ blob: Blob; filename: string } | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'image/png';
    if (!contentType.startsWith('image/')) return null;
    const buffer = await res.arrayBuffer();
    const ext = contentType.split('/')[1]?.split(';')[0] || 'png';
    return { blob: new Blob([buffer], { type: contentType }), filename: `argus.${ext}` };
  } catch {
    return null;
  }
}

export async function publishToFacebook(
  copy: string,
  primaryImageUrl: string | null,
  fallbackImageUrl: string | null,
): Promise<FacebookPublishResult> {
  if (process.env.FACEBOOK_ENABLED !== 'true') {
    return { enabled: false, reason: 'FACEBOOK_ENABLED != true' };
  }

  const pageId = process.env.FACEBOOK_PAGE_ID;
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!pageId || !token) {
    return { enabled: false, reason: 'FACEBOOK_PAGE_ID or FACEBOOK_PAGE_ACCESS_TOKEN missing' };
  }

  const version = process.env.FACEBOOK_GRAPH_VERSION || 'v20.0';
  const photosEndpoint = `https://graph.facebook.com/${version}/${pageId}/photos`;
  const feedEndpoint = `https://graph.facebook.com/${version}/${pageId}/feed`;
  const attempts: Array<{ source: string; kind: 'binary' | 'url' }> = [];

  // Strategy 1: binary upload (works from localhost / private hosts)
  if (primaryImageUrl) {
    const img = await fetchImageBlob(primaryImageUrl);
    if (img) {
      const form = new FormData();
      form.set('access_token', token);
      form.set('caption', copy);
      form.set('published', 'true');
      form.set('source', img.blob, img.filename);

      try {
        const res = await fetch(photosEndpoint, { method: 'POST', body: form });
        const data = await res.json().catch(() => ({}));
        const err = classifyFacebookError(data, res);
        if (!err) {
          return { enabled: true, ok: true, via: 'banner_binary', id: data.id || data.post_id, raw: data };
        }
        attempts.push({ source: 'binary', kind: 'binary' });
        if (err.expired || err.deprecated_permission) {
          return { enabled: true, attempts, ...err };
        }
        console.error('[facebook] binary upload failed:', JSON.stringify(err).slice(0, 240));
      } catch (e: any) {
        attempts.push({ source: 'binary', kind: 'binary' });
        console.error('[facebook] binary upload network error:', e.message);
      }
    } else {
      console.warn('[facebook] could not fetch image blob, falling back to URL');
    }
  }

  // Strategy 2: URL fetch — Facebook pulls the image from a public URL
  for (const candidate of [primaryImageUrl, fallbackImageUrl].filter(Boolean) as string[]) {
    const body = new URLSearchParams();
    body.set('access_token', token);
    body.set('url', candidate);
    body.set('caption', copy);
    body.set('published', 'true');

    try {
      const res = await fetch(photosEndpoint, { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      const err = classifyFacebookError(data, res);
      if (!err) {
        return { enabled: true, ok: true, via: 'url_fetch', source: candidate, id: data.id || data.post_id, raw: data };
      }
      attempts.push({ source: candidate, kind: 'url' });
      if (err.expired || err.deprecated_permission) {
        return { enabled: true, attempts, ...err };
      }
      console.error(`[facebook] url upload failed for ${candidate.slice(0, 80)}:`, JSON.stringify(err).slice(0, 240));
    } catch (e: any) {
      attempts.push({ source: candidate, kind: 'url' });
      console.error('[facebook] url upload network error:', e.message);
    }
  }

  // Strategy 3: text-only fallback so the alert still goes out
  try {
    const body = new URLSearchParams();
    body.set('access_token', token);
    body.set('message', copy);
    const res = await fetch(feedEndpoint, { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    const err = classifyFacebookError(data, res);
    if (!err) {
      return { enabled: true, ok: true, via: 'text_only', id: data.id || data.post_id, raw: data, attempts };
    }
    return { enabled: true, attempts, ...err };
  } catch (e: any) {
    return { enabled: true, ok: false, error: `Text fallback network error: ${e.message}`, attempts };
  }
}
