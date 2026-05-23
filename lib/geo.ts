export interface LatLng {
  lat: number;
  lng: number;
}

export function offsetKm(center: LatLng, dxKm: number, dyKm: number): LatLng {
  const newLat = center.lat + dyKm / 110.574;
  const newLng = center.lng + dxKm / (111.32 * Math.cos((center.lat * Math.PI) / 180));
  return { lat: newLat, lng: newLng };
}

export function haversineKm(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function clusterByDistance(points: LatLng[], radiusKm = 1.2): { centroid: LatLng; size: number }[] {
  const used = new Set<number>();
  const out: { centroid: LatLng; size: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    if (used.has(i)) continue;
    const group: LatLng[] = [points[i]];
    used.add(i);
    for (let j = i + 1; j < points.length; j++) {
      if (used.has(j)) continue;
      if (haversineKm(points[i], points[j]) <= radiusKm) {
        group.push(points[j]);
        used.add(j);
      }
    }
    const cLat = group.reduce((s, p) => s + p.lat, 0) / group.length;
    const cLng = group.reduce((s, p) => s + p.lng, 0) / group.length;
    out.push({ centroid: { lat: cLat, lng: cLng }, size: group.length });
  }
  return out;
}

const DIRECTIONS: { dx: number; dy: number; label: string }[] = [
  { dx: 1.2, dy: 0.6, label: 'Sector N-E' },
  { dx: -0.9, dy: 1.1, label: 'Sector N-O' },
  { dx: -1.4, dy: -0.6, label: 'Sector S-O' },
  { dx: 1.3, dy: -0.9, label: 'Sector S-E' },
  { dx: 0, dy: 1.6, label: 'Corredor norte' },
  { dx: 0, dy: -1.6, label: 'Corredor sur' },
];

export function probableSectors(center: LatLng, radiusKm = 0.85) {
  return DIRECTIONS.map((d) => {
    const c = offsetKm(center, d.dx, d.dy);
    return { label: d.label, lat: c.lat, lng: c.lng, radiusKm };
  });
}
