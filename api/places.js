/**
 * Consolidated hub for Google Places routes (Vercel Hobby plan's 12
 * Serverless Function cap forces route consolidation — see vercel.json
 * rewrites). Dispatches on `req.query.__r`. Keeps GOOGLE_MAPS_API_KEY
 * server-side.
 *
 * Routes folded in (original file → __r key):
 *   api/google/nearby-places.js → nearby-places
 *   api/google/text-search.js   → text-search
 */

function approximateDistanceM(latA, lonA, latB, lonB) {
  if (![latA, lonA, latB, lonB].every(Number.isFinite)) return Number.MAX_SAFE_INTEGER;
  const latitudeScale = 111320;
  const longitudeScale = latitudeScale * Math.cos((latA * Math.PI) / 180);
  return Math.round(Math.hypot((latB - latA) * latitudeScale, (lonB - lonA) * longitudeScale));
}

/** Folded in from api/google/nearby-places.js (__r=nearby-places). */
function placeContextPriority(types) {
  const typeSet = new Set(types);
  if (typeSet.has('historical_landmark') || typeSet.has('monument')) return 100;
  if (typeSet.has('tourist_attraction') || typeSet.has('museum')) return 90;
  if (typeSet.has('premise') || typeSet.has('street_address')) return 75;
  if (typeSet.has('point_of_interest')) return 60;
  if (typeSet.has('public_bathroom')) return 10;
  return 40;
}

async function handleNearbyPlaces(req, res) {
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
  const latitude = Number(requestUrl.searchParams.get('lat'));
  const longitude = Number(requestUrl.searchParams.get('lon'));
  const radiusM = Math.max(25, Math.min(5000, Number(requestUrl.searchParams.get('radiusM')) || 250));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    res.status(400).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'Valid lat and lon are required', places: [] }));
    return;
  }

  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': [
          'places.id', 'places.displayName', 'places.formattedAddress', 'places.shortFormattedAddress',
          'places.location', 'places.primaryType', 'places.primaryTypeDisplayName', 'places.types',
        ].join(','),
      },
      body: JSON.stringify({
        maxResultCount: 20,
        rankPreference: 'DISTANCE',
        locationRestriction: { circle: { center: { latitude, longitude }, radius: radiusM } },
      }),
      signal: AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => ({}));
    const seenPlaces = new Set();
    const places = Array.isArray(data.places) ? data.places
      .map((place) => {
        const placeLatitude = place.location?.latitude ?? null;
        const placeLongitude = place.location?.longitude ?? null;
        const types = Array.isArray(place.types) ? place.types.slice(0, 8) : [];
        return {
          id: place.id || null,
          name: place.displayName?.text || null,
          address: place.shortFormattedAddress || place.formattedAddress || null,
          latitude: placeLatitude,
          longitude: placeLongitude,
          distanceM: approximateDistanceM(latitude, longitude, placeLatitude, placeLongitude),
          primaryType: place.primaryTypeDisplayName?.text || place.primaryType || null,
          types,
          contextPriority: placeContextPriority(types),
        };
      })
      .filter((place) => {
        const key = `${place.name}:${place.address || ''}`.toLowerCase();
        if (!place.name || seenPlaces.has(key)) return false;
        seenPlaces.add(key);
        return true;
      })
      .sort((a, b) => b.contextPriority - a.contextPriority || a.distanceM - b.distanceM)
      .map(({ contextPriority, ...place }) => place)
      .slice(0, 20) : [];

    res.status(response.ok ? 200 : response.status);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(JSON.stringify({ places, error: response.ok ? null : data.error?.message || 'Google Places request failed' }));
  } catch (error) {
    res.status(502).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify({ error: error?.message || 'Google Places request failed', places: [] }));
  }
}

/** Folded in from api/google/text-search.js (__r=text-search). */
async function handleTextSearch(req, res) {
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

export default async function handler(req, res) {
  try {
    const route = req.query?.__r;
    if (route === 'nearby-places') return handleNearbyPlaces(req, res);
    if (route === 'text-search') return handleTextSearch(req, res);
    res.status(404).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'unknown_route' }));
  } catch (err) {
    console.error('[places hub]', err?.message || err);
    if (!res.headersSent) {
      res.status(500).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'internal_error', message: String(err?.message || err) }));
    }
  }
}
