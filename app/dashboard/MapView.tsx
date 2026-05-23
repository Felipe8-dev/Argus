'use client';

import mapboxgl from 'mapbox-gl';
import { useEffect, useMemo, useRef, useState } from 'react';

type MapMode = 'threat' | 'routes' | 'agents';

export interface MatchSpotlight {
  id: string;
  lng: number;
  lat: number;
  photoUrl?: string | null;
  portraitUrl?: string | null;
  sourceUrl?: string | null;
  sourceSite?: string | null;
  placeLabel?: string | null;
  confidence?: number | null;
  personName?: string | null;
}

interface LivePoint {
  lng: number;
  lat: number;
  label: string;
  severity: number;
  risk: string;
}

export interface AgentZone {
  agent: string;
  label: string;
  lat: number;
  lng: number;
  radiusKm: number;
  status: 'scanning' | 'complete' | 'error';
  progress?: number;
  color?: string;
}

export interface AgentMarker {
  agent: string;
  lat: number;
  lng: number;
  color: string;
  label?: string;
}

interface MapViewProps {
  mode?: MapMode;
  selectedCase?: string;
  livePoints?: LivePoint[];
  mapCenter?: { lat: number; lng: number } | null;
  latestMatch?: MatchSpotlight | null;
  portraitUrl?: string | null;
  agentZones?: AgentZone[];
  agentMarkers?: AgentMarker[];
  // External signal overlays (additive — page pasa empty FC para apagar)
  firmsLayer?: { type: 'FeatureCollection'; features: any[] } | null;
  usgsLayer?: { type: 'FeatureCollection'; features: any[] } | null;
  gdacsLayer?: { type: 'FeatureCollection'; features: any[] } | null;
  /** Radio externo (km) — controlado por el slider del operador */
  searchRadiusKm?: number;
  /** Modo "marcar avistamiento": cursor crosshair + captura siguiente click */
  pinMode?: boolean;
  /** Callback al clickear mapa en pin mode */
  onManualPin?: (lng: number, lat: number) => void;
}

// Default view: all of Colombia. So the map always shows something useful
// before the case is geocoded, instead of opening in the middle of the Atlantic.
const COLOMBIA_CENTER: [number, number] = [-73.5, 4.5];
const COLOMBIA_ZOOM = 5.2;

function isFinitePair(p: { lng?: any; lat?: any } | null | undefined): boolean {
  return Boolean(p) && Number.isFinite(Number(p!.lng)) && Number.isFinite(Number(p!.lat));
}

function buildThreatPoints(livePoints: LivePoint[]) {
  return {
    type: 'FeatureCollection' as const,
    features: livePoints
      .filter((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat))
      .map((item) => ({
        type: 'Feature' as const,
        properties: { name: item.label, severity: item.severity, risk: item.risk },
        geometry: { type: 'Point' as const, coordinates: [item.lng, item.lat] },
      })),
  };
}

// Build dynamic search rings around the case's last-known location, so the
// "operational" overlay is anchored to real data instead of hardcoded Cartagena polygons.
// El radio externo viene del operador (slider); los rings internos se calculan
// como fracciones para mantener la sensación de "anillos concéntricos".
function buildSearchRings(center: [number, number] | null, maxRadiusKm = 3) {
  if (!center) return { type: 'FeatureCollection' as const, features: [] };

  const [lng, lat] = center;
  const ringRadiiKm = [maxRadiusKm * 0.18, maxRadiusKm * 0.5, maxRadiusKm];
  const features = ringRadiiKm.map((radiusKm, i) => {
    const coords: number[][] = [];
    const steps = 64;
    // Approx: 1 deg lat ≈ 111km; 1 deg lng ≈ 111km * cos(lat)
    const latDeg = radiusKm / 111;
    const lngDeg = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
    for (let s = 0; s <= steps; s++) {
      const angle = (s / steps) * 2 * Math.PI;
      coords.push([lng + lngDeg * Math.cos(angle), lat + latDeg * Math.sin(angle)]);
    }
    return {
      type: 'Feature' as const,
      properties: { ring: i, radiusKm, label: `${radiusKm}km` },
      geometry: { type: 'Polygon' as const, coordinates: [coords] },
    };
  });
  return { type: 'FeatureCollection' as const, features };
}

// Live agent rings — one polygon per active scanning zone. Color comes from
// the agent palette in app/page.tsx and rides on the feature itself.
function buildAgentZones(zones: AgentZone[]) {
  return {
    type: 'FeatureCollection' as const,
    features: zones
      .filter((z) => Number.isFinite(z.lat) && Number.isFinite(z.lng))
      .map((z) => {
        const coords: number[][] = [];
        const steps = 56;
        const latDeg = z.radiusKm / 111;
        const lngDeg = z.radiusKm / (111 * Math.cos((z.lat * Math.PI) / 180));
        for (let s = 0; s <= steps; s++) {
          const angle = (s / steps) * 2 * Math.PI;
          coords.push([z.lng + lngDeg * Math.cos(angle), z.lat + latDeg * Math.sin(angle)]);
        }
        return {
          type: 'Feature' as const,
          properties: {
            agent: z.agent,
            label: z.label,
            status: z.status,
            color: z.color || '#0f766e',
          },
          geometry: { type: 'Polygon' as const, coordinates: [coords] },
        };
      }),
  };
}

function buildAgentMarkers(markers: AgentMarker[]) {
  return {
    type: 'FeatureCollection' as const,
    features: markers
      .filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng))
      .map((m) => ({
        type: 'Feature' as const,
        properties: { agent: m.agent, color: m.color, label: m.label || m.agent },
        geometry: { type: 'Point' as const, coordinates: [m.lng, m.lat] },
      })),
  };
}

// Token-missing explainer — shown instead of silently rendering a fake map.
function MissingTokenNotice() {
  return (
    <div className="argus-map-missing">
      <div className="argus-map-missing-inner">
        <div className="argus-map-missing-title">Mapa Mapbox no configurado</div>
        <div className="argus-map-missing-body">
          Define <code>NEXT_PUBLIC_MAPBOX_TOKEN=pk....</code> en tu <code>.env.local</code>
          {' '}(o en las Environment Variables de Vercel) y recarga.
        </div>
      </div>
    </div>
  );
}

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

export default function MapView({
  mode = 'threat',
  selectedCase = 'ARG-2048',
  livePoints = [],
  mapCenter,
  latestMatch,
  portraitUrl,
  agentZones = [],
  agentMarkers = [],
  firmsLayer = null,
  usgsLayer = null,
  gdacsLayer = null,
  searchRadiusKm = 3,
  pinMode = false,
  onManualPin,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const matchMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const matchPopupRef = useRef<mapboxgl.Popup | null>(null);
  const portraitMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const lastMatchIdRef = useRef<string | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const canUseMapbox = Boolean(token && token.startsWith('pk.'));

  // Case center — strictly from real data. Never falls back to a fake location.
  const caseCenter = useMemo<[number, number] | null>(() => {
    const firstPoint = livePoints.find((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat));
    if (firstPoint) return [firstPoint.lng, firstPoint.lat];
    if (isFinitePair(mapCenter)) return [Number(mapCenter!.lng), Number(mapCenter!.lat)];
    return null;
  }, [livePoints, mapCenter]);

  // -------------------- INIT --------------------
  useEffect(() => {
    if (!canUseMapbox || !containerRef.current || mapRef.current) return;

    mapboxgl.accessToken = token as string;

    let map: mapboxgl.Map;
    try {
      map = new mapboxgl.Map({
        container: containerRef.current,
        // Open over Colombia at country scale so the operator always sees land,
        // not the Atlantic. The case-specific easeTo runs as soon as we have coords.
        center: caseCenter ?? COLOMBIA_CENTER,
        zoom: caseCenter ? 13 : COLOMBIA_ZOOM,
        pitch: caseCenter ? 55 : 0,
        bearing: 0,
        style: 'mapbox://styles/mapbox/standard',
        antialias: true,
        attributionControl: false,
        config: {
          basemap: {
            lightPreset: 'dusk',
            showPointOfInterestLabels: true,
            showPlaceLabels: true,
            showRoadLabels: true,
            showTransitLabels: false,
          },
        },
      });
    } catch (err: any) {
      console.error('[map] failed to create map:', err);
      setMapError(err?.message || 'No se pudo inicializar el mapa');
      return;
    }

    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-left');

    // Surface Mapbox errors to the UI instead of dying silently. Most common:
    // 401 (invalid token), 403 (style not allowed), network failure.
    map.on('error', (e: any) => {
      const err = e?.error;
      const msg = err?.message || err?.statusText || 'Error desconocido de Mapbox';
      const status = err?.status;
      console.error('[map] error', status, msg, err);
      if (status === 401 || status === 403) {
        setMapError('Token de Mapbox invalido o sin permiso. Revisa NEXT_PUBLIC_MAPBOX_TOKEN.');
      } else if (!mapError) {
        // don't overwrite a more specific error
        setMapError(`Mapbox: ${msg}`);
      }
    });

    const onStyleLoad = () => {
      // Terrain (Standard style supports it, the source may not exist on older styles)
      try {
        if (!map.getSource('mapbox-dem')) {
          map.addSource('mapbox-dem', {
            type: 'raster-dem',
            url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
            tileSize: 512,
            maxzoom: 14,
          });
        }
        map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.2 });
      } catch (err) {
        console.warn('[map] terrain unavailable:', err);
      }

      // Sources we keep updating from React state.
      map.addSource('argus-threats', { type: 'geojson', data: buildThreatPoints(livePoints) as any });
      map.addSource('argus-rings', { type: 'geojson', data: buildSearchRings(caseCenter, searchRadiusKm) as any });

      // Heatmap of matches.
      map.addLayer({
        id: 'argus-heat',
        type: 'heatmap',
        source: 'argus-threats',
        maxzoom: 16,
        paint: {
          'heatmap-weight': ['interpolate', ['linear'], ['get', 'severity'], 0, 0, 1, 1],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 15, 3.4],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 11, 28, 15, 76],
          'heatmap-opacity': 0.78,
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(15,118,110,0)',
            0.28, 'rgba(20,184,166,0.42)',
            0.52, 'rgba(245,158,11,0.58)',
            0.78, 'rgba(239,68,68,0.72)',
            1, 'rgba(127,29,29,0.86)',
          ],
        },
      });

      // Individual dots per match — so a single match is also visible.
      map.addLayer({
        id: 'argus-threat-pulse',
        type: 'circle',
        source: 'argus-threats',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'severity'], 0.5, 12, 1, 26],
          'circle-color': ['match', ['get', 'risk'], 'critical', '#dc2626', 'high', '#d97706', '#0f766e'],
          'circle-opacity': 0.24,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });
      map.addLayer({
        id: 'argus-threat-core',
        type: 'circle',
        source: 'argus-threats',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'severity'], 0.5, 5, 1, 9],
          'circle-color': ['match', ['get', 'risk'], 'critical', '#b91c1c', 'high', '#c2410c', '#0f766e'],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });

      // Dynamic search rings around the case's last-known location.
      map.addLayer({
        id: 'argus-ring-fill',
        type: 'fill',
        source: 'argus-rings',
        paint: {
          'fill-color': '#14b8a6',
          'fill-opacity': ['interpolate', ['linear'], ['get', 'ring'], 0, 0.18, 2, 0.04],
        },
      });
      map.addLayer({
        id: 'argus-ring-line',
        type: 'line',
        source: 'argus-rings',
        paint: {
          'line-color': '#14b8a6',
          'line-width': 1.8,
          'line-dasharray': [3, 2],
          'line-opacity': 0.7,
        },
      });

      // Live agent zones — one circle per scanning agent. Each rides its own
      // color (driven by the page via the AgentZone.color field) and a dashed
      // outline while scanning, solid while complete.
      map.addSource('argus-agent-zones', { type: 'geojson', data: buildAgentZones(agentZones) as any });
      map.addLayer({
        id: 'argus-agent-zones-fill',
        type: 'fill',
        source: 'argus-agent-zones',
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': [
            'case',
            ['==', ['get', 'status'], 'complete'], 0.07,
            ['==', ['get', 'status'], 'error'], 0.16,
            0.18,
          ],
        },
      });
      map.addLayer({
        id: 'argus-agent-zones-line',
        type: 'line',
        source: 'argus-agent-zones',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2,
          'line-opacity': 0.85,
        },
      });

      // Live agent markers — moving dots that show where each agent is right
      // now. The aura layer is animated below.
      map.addSource('argus-agent-markers', { type: 'geojson', data: buildAgentMarkers(agentMarkers) as any });
      map.addLayer({
        id: 'argus-agent-aura',
        type: 'circle',
        source: 'argus-agent-markers',
        paint: {
          'circle-radius': 22,
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.18,
        },
      });
      map.addLayer({
        id: 'argus-agent-dots',
        type: 'circle',
        source: 'argus-agent-markers',
        paint: {
          'circle-radius': 7,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 3,
          'circle-stroke-color': '#06211f',
        },
      });

      setReady(true);
    };

    // style.load fires once after the style finishes loading. If a previous
    // version of mapbox-gl fires `load` instead, that's our backup.
    map.once('style.load', onStyleLoad);
    map.once('load', () => {
      if (!ready) {
        // Force resize after first load to handle the case where the container
        // mounted at 0x0 and grew afterwards. Safe to call multiple times.
        map.resize();
      }
    });

    // ResizeObserver so the map always matches its container.
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      resizeObserverRef.current = new ResizeObserver(() => {
        mapRef.current?.resize();
      });
      resizeObserverRef.current.observe(containerRef.current);
    }

    return () => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      matchMarkerRef.current?.remove();
      matchPopupRef.current?.remove();
      portraitMarkerRef.current?.remove();
      matchMarkerRef.current = null;
      matchPopupRef.current = null;
      portraitMarkerRef.current = null;
      lastMatchIdRef.current = null;
      try { map.remove(); } catch {}
      mapRef.current = null;
      setReady(false);
    };
    // We intentionally do NOT depend on caseCenter — the map is created once
    // and the camera is updated by the focus effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseMapbox, token]);

  // -------------------- DATA UPDATES --------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('argus-threats') as mapboxgl.GeoJSONSource | undefined)?.setData(buildThreatPoints(livePoints) as any);
    (map.getSource('argus-rings') as mapboxgl.GeoJSONSource | undefined)?.setData(buildSearchRings(caseCenter, searchRadiusKm) as any);
    (map.getSource('argus-agent-zones') as mapboxgl.GeoJSONSource | undefined)?.setData(buildAgentZones(agentZones) as any);
    (map.getSource('argus-agent-markers') as mapboxgl.GeoJSONSource | undefined)?.setData(buildAgentMarkers(agentMarkers) as any);
  }, [livePoints, caseCenter, agentZones, agentMarkers, searchRadiusKm, ready]);

  // -------------------- PIN MODE (manual sighting) --------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!pinMode) {
      map.getCanvas().style.cursor = '';
      return;
    }
    map.getCanvas().style.cursor = 'crosshair';
    const handler = (e: mapboxgl.MapMouseEvent) => {
      const { lng, lat } = e.lngLat;
      onManualPin?.(lng, lat);
    };
    map.once('click', handler);
    return () => {
      try { map.off('click', handler); } catch {}
      map.getCanvas().style.cursor = '';
    };
  }, [pinMode, onManualPin, ready]);

  // -------------------- EXTERNAL OVERLAY LAYERS --------------------
  // FIRMS (incendios) · USGS (sismos) · GDACS (desastres).
  // Markers vivos con aura pulsante para que se sientan como sirenas.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const ensureFires = () => {
      if (map.getSource('argus-firms')) return;
      map.addSource('argus-firms', { type: 'geojson', data: EMPTY_FC as any });
      // Aura anaranjada (pulse)
      map.addLayer({
        id: 'argus-firms-aura',
        type: 'circle',
        source: 'argus-firms',
        paint: {
          'circle-radius': 22,
          'circle-color': '#ff5a18',
          'circle-opacity': 0.22,
          'circle-blur': 0.6,
        },
      });
      // Núcleo brillante, escalado por intensidad (brillo TI4)
      map.addLayer({
        id: 'argus-firms-core',
        type: 'circle',
        source: 'argus-firms',
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['coalesce', ['get', 'bright_ti4'], 320],
            290, 4, 360, 8, 420, 12,
          ],
          'circle-color': '#ffb340',
          'circle-stroke-color': '#fff5e0',
          'circle-stroke-width': 1.5,
          'circle-opacity': 0.95,
        },
      });
    };

    const ensureQuakes = () => {
      if (map.getSource('argus-usgs')) return;
      map.addSource('argus-usgs', { type: 'geojson', data: EMPTY_FC as any });
      // Onda externa (ripple)
      map.addLayer({
        id: 'argus-usgs-ripple',
        type: 'circle',
        source: 'argus-usgs',
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['coalesce', ['get', 'mag'], 4],
            3, 18, 6, 36, 8, 60,
          ],
          'circle-color': '#ff3d8a',
          'circle-opacity': 0.18,
          'circle-blur': 0.7,
        },
      });
      // Núcleo + radio según magnitud
      map.addLayer({
        id: 'argus-usgs-core',
        type: 'circle',
        source: 'argus-usgs',
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['coalesce', ['get', 'mag'], 4],
            3, 4, 6, 9, 8, 14,
          ],
          'circle-color': '#ff5fa5',
          'circle-stroke-color': '#ffe5f0',
          'circle-stroke-width': 1.8,
          'circle-opacity': 0.94,
        },
      });
    };

    const ensureDisasters = () => {
      if (map.getSource('argus-gdacs')) return;
      map.addSource('argus-gdacs', { type: 'geojson', data: EMPTY_FC as any });
      // Halo amber/red por nivel de alerta
      map.addLayer({
        id: 'argus-gdacs-halo',
        type: 'circle',
        source: 'argus-gdacs',
        paint: {
          'circle-radius': 26,
          'circle-color': [
            'match', ['get', 'alert_level'],
            'Red', '#e5573a',
            'Orange', '#f5a142',
            '#ffd166',
          ],
          'circle-opacity': 0.20,
          'circle-blur': 0.55,
        },
      });
      map.addLayer({
        id: 'argus-gdacs-core',
        type: 'circle',
        source: 'argus-gdacs',
        paint: {
          'circle-radius': 8,
          'circle-color': [
            'match', ['get', 'alert_level'],
            'Red', '#ff7d68',
            'Orange', '#ffc580',
            '#ffe27a',
          ],
          'circle-stroke-color': '#fff6df',
          'circle-stroke-width': 2,
          'circle-opacity': 0.96,
        },
      });
    };

    ensureFires();
    ensureQuakes();
    ensureDisasters();

    (map.getSource('argus-firms') as mapboxgl.GeoJSONSource | undefined)?.setData((firmsLayer || EMPTY_FC) as any);
    (map.getSource('argus-usgs') as mapboxgl.GeoJSONSource | undefined)?.setData((usgsLayer || EMPTY_FC) as any);
    (map.getSource('argus-gdacs') as mapboxgl.GeoJSONSource | undefined)?.setData((gdacsLayer || EMPTY_FC) as any);

    // Click popups — todas las capas usan el mismo handler con metadata distinta.
    const popupFor = (e: any, kind: 'firms' | 'usgs' | 'gdacs') => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties || {};
      let html = '';
      if (kind === 'firms') {
        html = `<div class="ov-popup ov-popup--fire">
          <div class="ov-pop-kicker">🔥 NASA FIRMS</div>
          <div class="ov-pop-title">Hotspot activo</div>
          <div class="ov-pop-meta">Brillo TI4: <b>${Math.round(p.bright_ti4 || 0)}</b> · FRP <b>${Math.round(p.frp || 0)}</b></div>
          <div class="ov-pop-meta">${p.acq_date || ''} ${p.acq_time || ''} · ${p.confidence || ''}</div>
        </div>`;
      } else if (kind === 'usgs') {
        html = `<div class="ov-popup ov-popup--quake">
          <div class="ov-pop-kicker">🌍 USGS</div>
          <div class="ov-pop-title">${p.title || `Sismo M${p.mag ?? '?'}`}</div>
          <div class="ov-pop-meta">${p.place || 'ubicación pendiente'}</div>
          ${p.url ? `<a class="ov-pop-link" href="${p.url}" target="_blank" rel="noreferrer">ver detalle USGS →</a>` : ''}
        </div>`;
      } else {
        html = `<div class="ov-popup ov-popup--disaster">
          <div class="ov-pop-kicker">⚠️ GDACS · ${p.alert_level || '—'}</div>
          <div class="ov-pop-title">${p.title || 'Alerta de desastre'}</div>
          <div class="ov-pop-meta">${(p.description || '').slice(0, 160)}</div>
          ${p.link ? `<a class="ov-pop-link" href="${p.link}" target="_blank" rel="noreferrer">abrir GDACS →</a>` : ''}
        </div>`;
      }
      new mapboxgl.Popup({ closeButton: true, maxWidth: '280px' })
        .setLngLat(e.lngLat)
        .setHTML(html)
        .addTo(map);
    };

    const onFire = (e: any) => popupFor(e, 'firms');
    const onQuake = (e: any) => popupFor(e, 'usgs');
    const onDis = (e: any) => popupFor(e, 'gdacs');
    const setCursor = (c: string) => () => (map.getCanvas().style.cursor = c);

    map.on('click', 'argus-firms-core', onFire);
    map.on('click', 'argus-usgs-core', onQuake);
    map.on('click', 'argus-gdacs-core', onDis);
    map.on('mouseenter', 'argus-firms-core', setCursor('pointer'));
    map.on('mouseenter', 'argus-usgs-core', setCursor('pointer'));
    map.on('mouseenter', 'argus-gdacs-core', setCursor('pointer'));
    map.on('mouseleave', 'argus-firms-core', setCursor(''));
    map.on('mouseleave', 'argus-usgs-core', setCursor(''));
    map.on('mouseleave', 'argus-gdacs-core', setCursor(''));

    return () => {
      try {
        map.off('click', 'argus-firms-core', onFire);
        map.off('click', 'argus-usgs-core', onQuake);
        map.off('click', 'argus-gdacs-core', onDis);
      } catch {}
    };
  }, [firmsLayer, usgsLayer, gdacsLayer, ready]);

  // Pulse aura de las 3 capas externas — sin esto se sienten estáticas.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let frame: number;
    const tick = (t: number) => {
      const phase = Math.sin(t / 380) * 0.5 + 0.5;
      if (map.getLayer('argus-firms-aura')) {
        map.setPaintProperty('argus-firms-aura', 'circle-radius', 18 + phase * 14);
        map.setPaintProperty('argus-firms-aura', 'circle-opacity', 0.10 + phase * 0.20);
      }
      if (map.getLayer('argus-usgs-ripple')) {
        map.setPaintProperty('argus-usgs-ripple', 'circle-opacity', 0.08 + phase * 0.18);
      }
      if (map.getLayer('argus-gdacs-halo')) {
        map.setPaintProperty('argus-gdacs-halo', 'circle-radius', 22 + phase * 10);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  // -------------------- AGENT AURA PULSE --------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let frame: number;
    const tick = (t: number) => {
      if (map.getLayer('argus-agent-aura')) {
        map.setPaintProperty('argus-agent-aura', 'circle-radius', 18 + Math.sin(t / 320) * 9);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  // -------------------- CAMERA: follow case --------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const cameraByMode = {
      threat: { zoom: 13.5, pitch: 55, bearing: 0 },
      routes: { zoom: 13, pitch: 60, bearing: -25 },
      agents: { zoom: 14, pitch: 65, bearing: -10 },
    }[mode];

    if (caseCenter) {
      map.easeTo({ ...cameraByMode, center: caseCenter, duration: 1200, essential: true });
    } else {
      // No case data yet — go back to a wide Colombia view.
      map.easeTo({ center: COLOMBIA_CENTER, zoom: COLOMBIA_ZOOM, pitch: 0, bearing: 0, duration: 800, essential: true });
    }
  }, [mode, caseCenter, ready]);

  // -------------------- CASE PORTRAIT PIN --------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    portraitMarkerRef.current?.remove();
    portraitMarkerRef.current = null;
    if (!caseCenter) return;

    const el = document.createElement('div');
    el.className = 'argus-case-marker';
    if (portraitUrl) {
      const img = document.createElement('img');
      img.src = portraitUrl;
      img.alt = 'caso';
      el.appendChild(img);
    }
    portraitMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat(caseCenter)
      .setPopup(new mapboxgl.Popup({ offset: 24 }).setText('Ultima ubicacion reportada'))
      .addTo(map);
  }, [caseCenter, portraitUrl, ready]);

  // -------------------- DRAMATIC FLY-TO ON MATCH --------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !latestMatch) return;
    if (!Number.isFinite(latestMatch.lng) || !Number.isFinite(latestMatch.lat)) return;
    if (lastMatchIdRef.current === latestMatch.id) return;
    lastMatchIdRef.current = latestMatch.id;

    matchMarkerRef.current?.remove();
    matchPopupRef.current?.remove();

    const el = document.createElement('div');
    el.className = 'argus-match-marker';
    if (latestMatch.photoUrl) {
      const img = document.createElement('img');
      img.src = latestMatch.photoUrl;
      img.alt = latestMatch.personName || 'match';
      el.appendChild(img);
    }
    matchMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([latestMatch.lng, latestMatch.lat])
      .addTo(map);

    const escape = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string));
    const confidencePct = latestMatch.confidence != null
      ? `${Math.round(Number(latestMatch.confidence) * 100)}%`
      : '—';
    const place = escape(latestMatch.placeLabel || '');
    const source = escape(latestMatch.sourceSite || '');
    const sourceLink = latestMatch.sourceUrl
      ? `<a href="${escape(latestMatch.sourceUrl)}" target="_blank" rel="noreferrer" class="argus-popup-link">Abrir fuente</a>`
      : '';

    const popupHtml = `
      <div class="argus-popup">
        <div class="argus-popup-header">
          <span class="argus-popup-tag">MATCH ${confidencePct}</span>
          <span class="argus-popup-source">${source}</span>
        </div>
        <div class="argus-popup-photos">
          ${latestMatch.portraitUrl ? `<div class="argus-popup-photo"><div class="argus-popup-label">Familia</div><img src="${escape(latestMatch.portraitUrl)}" alt="familia" /></div>` : ''}
          ${latestMatch.photoUrl ? `<div class="argus-popup-photo"><div class="argus-popup-label argus-popup-label-red">Encontrada</div><img src="${escape(latestMatch.photoUrl)}" alt="match" /></div>` : ''}
        </div>
        ${place ? `<div class="argus-popup-place">${place}</div>` : ''}
        ${sourceLink}
      </div>
    `;

    matchPopupRef.current = new mapboxgl.Popup({ offset: 24, closeButton: true, maxWidth: '340px', className: 'argus-mapbox-popup' })
      .setLngLat([latestMatch.lng, latestMatch.lat])
      .setHTML(popupHtml)
      .addTo(map);

    // Cinematic two-step: pull back, then dive in on the match.
    map.easeTo({ center: [latestMatch.lng, latestMatch.lat], zoom: 10, pitch: 30, duration: 800, essential: true });
    window.setTimeout(() => {
      mapRef.current?.flyTo({
        center: [latestMatch.lng, latestMatch.lat],
        zoom: 17.5,
        pitch: 72,
        bearing: -22,
        speed: 0.7,
        curve: 1.6,
        essential: true,
      });
    }, 900);
  }, [latestMatch, ready]);

  // -------------------- RENDER --------------------
  if (!canUseMapbox) return <MissingTokenNotice />;

  return (
    <div className="mapbox-stage">
      <div ref={containerRef} className="argus-mapbox" />
      <div className="map-live-hud">
        <span>Case {selectedCase}</span>
        <strong>{mode === 'agents' ? 'Agent Telemetry' : mode === 'routes' ? 'Route Reconstruction' : 'Live Threat Surface'}</strong>
        {(agentZones.length > 0 || agentMarkers.length > 0) && (
          <em>{agentZones.length} zonas · {agentMarkers.length} agentes</em>
        )}
      </div>
      {mapError && (
        <div className="argus-map-error">
          <strong>Mapa:</strong> {mapError}
        </div>
      )}
    </div>
  );
}
