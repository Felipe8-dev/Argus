/**
 * NASA FIRMS — Fire Information for Resource Management System.
 * Detecciones activas de incendios via VIIRS_NOAA20_NRT.
 * Requiere MAP_KEY (free, instantáneo): https://firms.modaps.eosdis.nasa.gov/api/
 */

const cache = new Map<string, { at: number; data: any }>();
const TTL_MS = 10 * 60_000;

interface FirePoint {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    bright_ti4?: number;
    bright_ti5?: number;
    confidence?: string;
    frp?: number;
    acq_date?: string;
    acq_time?: string;
    daynight?: string;
  };
}

function parseCsv(csv: string): FirePoint[] {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim());
  const idx = (k: string) => header.indexOf(k);
  const iLat = idx('latitude');
  const iLon = idx('longitude');
  const iBri = idx('bright_ti4');
  const iBri5 = idx('bright_ti5');
  const iConf = idx('confidence');
  const iFrp = idx('frp');
  const iDate = idx('acq_date');
  const iTime = idx('acq_time');
  const iDN = idx('daynight');

  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const lat = parseFloat(cells[iLat]);
    const lon = parseFloat(cells[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        bright_ti4: parseFloat(cells[iBri]),
        bright_ti5: parseFloat(cells[iBri5]),
        confidence: cells[iConf],
        frp: parseFloat(cells[iFrp]),
        acq_date: cells[iDate],
        acq_time: cells[iTime],
        daynight: cells[iDN],
      },
    } as FirePoint;
  }).filter((x): x is FirePoint => !!x);
}

export async function fetchFiresAround(
  lat: number,
  lng: number,
  bufferDeg = 2,
): Promise<{ type: 'FeatureCollection'; features: FirePoint[]; configured: boolean }> {
  const key = process.env.NASA_FIRMS_MAP_KEY;
  if (!key) {
    return { type: 'FeatureCollection', features: [], configured: false };
  }

  const bbox = [
    (lng - bufferDeg).toFixed(3),
    (lat - bufferDeg).toFixed(3),
    (lng + bufferDeg).toFixed(3),
    (lat + bufferDeg).toFixed(3),
  ].join(',');

  const cacheKey = `${bbox}-1`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return { ...cached.data, configured: true };
  }

  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_NOAA20_NRT/${bbox}/1`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`firms ${res.status}`);
    const csv = await res.text();
    if (csv.toLowerCase().startsWith('invalid')) {
      console.error('[firms] invalid response:', csv.slice(0, 120));
      return { type: 'FeatureCollection', features: [], configured: true };
    }
    const features = parseCsv(csv);
    const data = { type: 'FeatureCollection' as const, features };
    cache.set(cacheKey, { at: Date.now(), data });
    return { ...data, configured: true };
  } catch (err: any) {
    console.error('[firms] fetch failed:', err?.message);
    return { type: 'FeatureCollection', features: [], configured: true };
  }
}
