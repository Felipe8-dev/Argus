// Geocoding helpers — extracted from the legacy launch-pipeline route so both
// the API entrypoint (fast response) and the LangGraph nodes can resolve a
// free-form Spanish location into coordinates without duplicating logic.

export interface GeoResult {
  gps_lat: number;
  gps_lon: number;
  place_label: string;
}

function getMapboxTokens(): string[] {
  return [process.env.MAPBOX_TOKEN, process.env.NEXT_PUBLIC_MAPBOX_TOKEN]
    .map((t) => t?.trim())
    .filter(Boolean) as string[];
}

interface MapboxHit {
  lon: number;
  lat: number;
  label: string;
  relevance: number;
  placeType: string | null;
}

/**
 * Ask Mapbox for up to N candidates and pick the most relevant one.
 * `proximity` biases ranking toward a known city center when we have one.
 */
async function mapboxQuery(
  query: string,
  opts: { proximity?: [number, number]; types?: string } = {},
): Promise<MapboxHit | null> {
  const tokens = getMapboxTokens();
  if (!query || tokens.length === 0) return null;

  const params = new URLSearchParams({
    limit: '5',
    language: 'es',
    country: 'co',
    autocomplete: 'false',
  });
  if (opts.proximity) params.set('proximity', `${opts.proximity[0]},${opts.proximity[1]}`);
  if (opts.types) params.set('types', opts.types);

  for (const token of tokens) {
    params.set('access_token', token);
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?${params.toString()}`;
    const response = await fetch(url).catch(() => null);
    if (!response) continue;
    if (!response.ok) {
      console.warn(`[geocode] token failed status=${response.status} q="${query.slice(0, 60)}"`);
      continue;
    }
    const data = await response.json().catch(() => ({}));
    const features = Array.isArray(data?.features) ? data.features : [];
    if (features.length === 0) return null;
    const best = features
      .filter((f: any) => Array.isArray(f?.center) && f.center.length >= 2)
      .sort((a: any, b: any) => Number(b?.relevance || 0) - Number(a?.relevance || 0))[0];
    if (!best) return null;
    return {
      lon: Number(best.center[0]),
      lat: Number(best.center[1]),
      label: best.place_name || query,
      relevance: Number(best.relevance || 0),
      placeType: Array.isArray(best.place_type) ? best.place_type[0] : null,
    };
  }
  return null;
}

/**
 * Split a free-form Spanish location into (barrio, ciudad). Handles the most
 * common shapes the agent extracts: "barrio Pastrana, Magangué",
 * "Centro de Barranquilla", "Bocagrande, Cartagena", or just a city name.
 */
function parseLocation(raw: string): { barrio: string | null; city: string | null; raw: string } {
  const cleaned = raw.replace(/\s+/g, ' ').trim();

  const barrioComma = cleaned.match(/^barrio\s+([^,]+?)\s*(?:,|\s+en\s+)\s*(.+)$/i);
  if (barrioComma) return { barrio: barrioComma[1].trim(), city: barrioComma[2].trim(), raw: cleaned };

  const sectorOf = cleaned.match(/^(centro|norte|sur|oriente|occidente|este|oeste)\s+de\s+(.+)$/i);
  if (sectorOf) return { barrio: sectorOf[1].trim(), city: sectorOf[2].trim(), raw: cleaned };

  const comma = cleaned.match(/^([^,]+),\s*(.+)$/);
  if (comma) return { barrio: comma[1].trim(), city: comma[2].trim(), raw: cleaned };

  const barrioOnly = cleaned.match(/^barrio\s+(.+)$/i);
  if (barrioOnly) return { barrio: barrioOnly[1].trim(), city: null, raw: cleaned };

  return { barrio: null, city: cleaned, raw: cleaned };
}

/** Resolve a free-form last-seen location into coordinates + a clean label. */
export async function geocodeLocation(location?: string): Promise<GeoResult | null> {
  if (!location) return null;
  if (getMapboxTokens().length === 0) return null;

  const { barrio, city, raw } = parseLocation(location);

  let cityHit: MapboxHit | null = null;
  if (city) {
    cityHit = await mapboxQuery(`${city}, Colombia`, { types: 'place,locality,district,region' });
  }

  if (barrio && cityHit) {
    const refined = await mapboxQuery(`${barrio}, ${cityHit.label}`, {
      proximity: [cityHit.lon, cityHit.lat],
      types: 'neighborhood,locality,address,poi',
    });
    if (refined && refined.relevance >= 0.5) {
      return { gps_lon: refined.lon, gps_lat: refined.lat, place_label: refined.label };
    }
    return { gps_lon: cityHit.lon, gps_lat: cityHit.lat, place_label: cityHit.label };
  }

  if (cityHit) {
    return { gps_lon: cityHit.lon, gps_lat: cityHit.lat, place_label: cityHit.label };
  }

  const fallback = await mapboxQuery(
    raw.toLowerCase().includes('colombia') ? raw : `${raw}, Colombia`,
  );
  if (!fallback) return null;
  return { gps_lon: fallback.lon, gps_lat: fallback.lat, place_label: fallback.label };
}
