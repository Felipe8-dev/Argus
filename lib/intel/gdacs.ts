/**
 * GDACS — Global Disaster Alert & Coordination System.
 * RSS público sin key. Parsea a GeoJSON liviano para Mapbox.
 * https://www.gdacs.org/
 */

const RSS_URL = 'https://www.gdacs.org/xml/rss.xml';

const cache: { at: number; data: any | null } = { at: 0, data: null };
const TTL_MS = 10 * 60_000;

interface GdacsItem {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    title: string;
    link: string;
    description?: string;
    alert_level?: 'Green' | 'Orange' | 'Red' | string;
    event_type?: string;
    pub_date?: string;
  };
}

function extract(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let match;
  while ((match = re.exec(xml))) out.push(match[1]);
  return out;
}

function extractAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}[^>]*${attr}="([^"]+)"`, 'i');
  const m = re.exec(xml);
  return m ? m[1] : null;
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();
}

function parseRss(xml: string): GdacsItem[] {
  const items = extract(xml, 'item');
  return items
    .map((item) => {
      const title = stripCdata(extract(item, 'title')[0] || '');
      const link = stripCdata(extract(item, 'link')[0] || '');
      const description = stripCdata(extract(item, 'description')[0] || '');
      const pub_date = stripCdata(extract(item, 'pubDate')[0] || '');
      const alert_level = (stripCdata(extract(item, 'gdacs:alertlevel')[0] || '') || undefined) as any;
      const event_type = stripCdata(extract(item, 'gdacs:eventtype')[0] || '') || undefined;

      // Point coordinates: <georss:point>lat lon</georss:point>
      const pointStr = stripCdata(extract(item, 'georss:point')[0] || '');
      const [latStr, lonStr] = pointStr.split(/\s+/);
      const lat = parseFloat(latStr);
      const lon = parseFloat(lonStr);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { title, link, description: description.slice(0, 280), alert_level, event_type, pub_date },
      } as GdacsItem;
    })
    .filter((x): x is GdacsItem => !!x);
}

export async function fetchActiveDisasters(): Promise<{ type: 'FeatureCollection'; features: GdacsItem[] }> {
  const now = Date.now();
  if (cache.data && now - cache.at < TTL_MS) return cache.data;

  try {
    const res = await fetch(RSS_URL, { headers: { Accept: 'application/rss+xml,application/xml' } });
    if (!res.ok) throw new Error(`gdacs ${res.status}`);
    const xml = await res.text();
    const features = parseRss(xml);
    const data = { type: 'FeatureCollection' as const, features };
    cache.at = now;
    cache.data = data;
    return data;
  } catch (err: any) {
    console.error('[gdacs] fetch failed:', err?.message);
    return { type: 'FeatureCollection', features: [] };
  }
}
