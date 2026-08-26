/**
 * Vercel port of vite.config.js's googlePlacesContextProxy()
 * /api/google/text-search route. Keeps GOOGLE_MAPS_API_KEY server-side.
 */
function approximateDistanceM(latA, lonA, latB, lonB) {
  if (![latA, lonA, latB, lonB].every(Number.isFinite)) return Number.MAX_SAFE_INTEGER;
  const latitudeScale = 111320;
  const longitudeScale = latitudeScale * Math.cos((latA * Math.PI) / 180);
  return Math.round(Math.hypot((latB - latA) * latitudeScale, (lonB - lonA) * longitudeScale));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'Method not allowed', places: [] }));
    return;
  }
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    res.status(503).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'GOOGLE_MAPS_API_KEY is not set', places: [] }));
    return;
  }

  const requestUrl = new URL(req.url || '', 'http://localhost');
  const textQuery = String(requestUrl.searchParams.get('q') || '').trim();
  const latitude = Number(requestUrl.searchParams.get('lat'));
  const longitude = Number(requestUrl.searchParams.get('lon'));
  const radiusM = Math.max(50, Math.min(50000, Number(requestUrl.searchParams.get('radiusM')) || 4000));
  if (!textQuery || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    res.status(400).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'q, lat and lon are required', places: [] }));
    return;
  }

  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': [
          'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
          'places.viewport', 'places.primaryType', 'places.types',
        ].join(','),
      },
      body: JSON.stringify({
        textQuery,
        locationBias: { circle: { center: { latitude, longitude }, radius: radiusM } },
        maxResultCount: 5,
      }),
      signal: AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => ({}));
    const places = Array.isArray(data.places) ? data.places
      .map((place) => {
        const placeLatitude = place.location?.latitude ?? null;
        const placeLongitude = place.location?.longitude ?? null;
        const types = Array.isArray(place.types) ? place.types.slice(0, 8) : [];
        const vp = place.viewport;
        const viewport = (
          Number.isFinite(vp?.low?.latitude) && Number.isFinite(vp?.low?.longitude)
          && Number.isFinite(vp?.high?.latitude) && Number.isFinite(vp?.high?.longitude)
        ) ? {
          low: { latitude: vp.low.latitude, longitude: vp.low.longitude },
          high: { latitude: vp.high.latitude, longitude: vp.high.longitude },
        } : null;
        return {
          id: place.id || null,
          name: place.displayName?.text || null,
          address: place.formattedAddress || null,
          latitude: placeLatitude,
          longitude: placeLongitude,
          distanceM: approximateDistanceM(latitude, longitude, placeLatitude, placeLongitude),
          primaryType: place.primaryType || null,
          types,
          viewport,
        };
      })
      .filter((place) => place.name) : [];

    res.status(response.ok ? 200 : response.status);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(JSON.stringify({ places, error: response.ok ? null : data.error?.message || 'Google Places request failed' }));
  } catch (error) {
    res.status(502).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify({ error: error?.message || 'Google Places request failed', places: [] }));
  }
}
