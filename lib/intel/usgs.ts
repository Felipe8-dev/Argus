/**
 * USGS Earthquake feed — eventos sísmicos significativos última semana.
 * Endpoint público, sin key. https://earthquake.usgs.gov/
 */

const SUMMARY_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson';

const cache: { at: number; data: any | null } = { at: 0, data: null };
const TTL_MS = 10 * 60_000;

export async function fetchSignificantEarthquakes(): Promise<any> {
  const now = Date.now();
  if (cache.data && now - cache.at < TTL_MS) return cache.data;

  try {
    const res = await fetch(SUMMARY_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`usgs ${res.status}`);
    const json = await res.json();
    cache.at = now;
    cache.data = json;
    return json;
  } catch (err: any) {
    console.error('[usgs] fetch failed:', err?.message);
    return { type: 'FeatureCollection', features: [] };
  }
}
