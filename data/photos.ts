/**
 * Catálogo de "publicaciones públicas" servidas por la red social sintética.
 * Ghost (agente visual) las recorre vía /api/photos. Cada entrada con
 * coordenadas aparece como punto de barrido en el mapa.
 *
 * - `filename`: archivo bajo public/photos/ (solo se incluye si existe).
 * - `url`: alternativa externa cuando no hay archivo local.
 *   Si hay `url`, el filtro de existencia local NO aplica.
 */

export interface SeedPhoto {
  id: string;
  filename?: string;
  url?: string;
  source_site: string;
  username: string;
  postedAt: string;
  caption: string;
  isTarget?: boolean;
  gps_lat?: number;
  gps_lon?: number;
  place_label?: string;
  exif?: {
    lat: number;
    lon: number;
    takenAt: string;
  };
}

export const PHOTOS: SeedPhoto[] = [
  {
    id: 'cb-001',
    filename: 'beach-couple.jpg',
    source_site: 'Caribook',
    username: 'sofi.castro',
    postedAt: '2026-04-08T19:14:00-05:00',
    caption: 'Tarde de domingo en Bocagrande con mi amor 💙',
    isTarget: true,
    gps_lat: 10.4006,
    gps_lon: -75.5519,
    place_label: 'Bocagrande, Cartagena',
    exif: { lat: 10.4006, lon: -75.5519, takenAt: '2026-04-08T17:32:00-05:00' },
  },
  {
    id: 'cb-002',
    filename: 'street-food.jpg',
    url: 'https://picsum.photos/seed/argus-cb2/640/480',
    source_site: 'Caribook',
    username: 'sofi.castro',
    postedAt: '2026-04-07T13:02:00-05:00',
    caption: 'Las mejores arepas de huevo del centro 🤤',
    gps_lat: 10.4231,
    gps_lon: -75.5485,
    place_label: 'Centro Histórico, Cartagena',
  },
  {
    id: 'cb-003',
    filename: 'group-friends.jpg',
    url: 'https://picsum.photos/seed/argus-cb3/640/480',
    source_site: 'Caribook',
    username: 'andres.pacheco',
    postedAt: '2026-04-06T22:10:00-05:00',
    caption: 'Reencuentro con los del colegio 🍻',
    gps_lat: 10.4145,
    gps_lon: -75.5439,
    place_label: 'Getsemaní, Cartagena',
  },
  {
    id: 'bw-001',
    url: 'https://picsum.photos/seed/argus-bw1/640/480',
    source_site: 'BarrioWatch',
    username: 'vigilante.bocagrande',
    postedAt: '2026-04-09T08:24:00-05:00',
    caption: 'Reporte vecinal · personas no reconocidas en la zona.',
    gps_lat: 10.3988,
    gps_lon: -75.5571,
    place_label: 'Bocagrande Sur',
  },
  {
    id: 'bw-002',
    url: 'https://picsum.photos/seed/argus-bw2/640/480',
    source_site: 'BarrioWatch',
    username: 'vigilante.manga',
    postedAt: '2026-04-08T21:46:00-05:00',
    caption: 'Reporte vecinal · concentración inusual cerca del puente.',
    gps_lat: 10.4090,
    gps_lon: -75.5380,
    place_label: 'Manga',
  },
  {
    id: 'av-001',
    url: 'https://picsum.photos/seed/argus-av1/640/480',
    source_site: 'AvistaCol',
    username: 'avistacol.bot',
    postedAt: '2026-04-09T11:02:00-05:00',
    caption: 'Posible avistamiento reportado por la comunidad.',
    gps_lat: 10.4189,
    gps_lon: -75.5505,
    place_label: 'Plaza San Diego',
  },
  {
    id: 'av-002',
    url: 'https://picsum.photos/seed/argus-av2/640/480',
    source_site: 'AvistaCol',
    username: 'avistacol.bot',
    postedAt: '2026-04-09T15:40:00-05:00',
    caption: 'Coincidencia visual baja confianza en cámara comercial.',
    gps_lat: 10.4252,
    gps_lon: -75.5408,
    place_label: 'Castillo San Felipe',
  },
  {
    id: 'cb-004',
    url: 'https://picsum.photos/seed/argus-cb4/640/480',
    source_site: 'Caribook',
    username: 'marcela.ruiz',
    postedAt: '2026-04-08T19:58:00-05:00',
    caption: 'Atardecer perfecto en el muelle.',
    gps_lat: 10.4108,
    gps_lon: -75.5494,
    place_label: 'Muelle de La Bodeguita',
  },
];
