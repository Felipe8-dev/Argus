import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const location = req.nextUrl.searchParams.get('location');
  if (!location) return NextResponse.json({ error: 'No location' }, { status: 400 });

  const token = process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) {
    return NextResponse.json({ error: 'MAPBOX_TOKEN not configured' }, { status: 503 });
  }

  // Bias the search to Colombia and append the country if the user didn't already say so.
  const search = location.toLowerCase().includes('colombia') ? location : `${location}, Colombia`;
  const encodedLocation = encodeURIComponent(search);
  const mapboxUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodedLocation}.json?limit=1&language=es&country=co&access_token=${encodeURIComponent(token)}`;

  try {
    const res = await fetch(mapboxUrl);
    const data = await res.json();
    const feature = data.features?.[0];
    
    if (!feature?.center) {
      return NextResponse.json({ 
        error: 'Not found',
        location,
        features_count: data.features?.length,
        query: data.query,
      }, { status: 404 });
    }

    return NextResponse.json({
      lng: feature.center[0],
      lat: feature.center[1],
      label: feature.place_name,
    });
  } catch (err) {
    console.error('[geocode] Error:', err);
    return NextResponse.json({ error: 'Geocoding failed', details: String(err) }, { status: 500 });
  }
}