/**
 * Vercel port of vite.config.js's /api/route (OSRM routing via FOSSGIS mirrors).
 * GET ?profile=foot|car|bike&coords=lon,lat;lon,lat[;...]
 */
import { readResponseTextCapped, haversineKm } from './_lib/http.js';

const ROUTE_CACHE_MS = 5 * 60_000;
const ROUTE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ROUTE_MAX_LEG_KM = 600;
const ROUTE_MAX_TOTAL_KM = 2500;
const _routeCache = new Map();

export default async function handler(req, res) {
  const fail = (msg) => {
    res.status(200).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ ok: false, error: msg }));
  };
  try {
    const url = new URL(req.url, 'http://localhost');
    const raw = (url.searchParams.get('profile') || 'foot').toLowerCase();
    const profile = (raw === 'car' || raw === 'driving') ? 'car'
      : (raw === 'bike' || raw === 'cycling' || raw === 'bicycle') ? 'bike'
        : (raw === 'foot' || raw === 'walking' || raw === 'walk') ? 'foot'
          : null;
    if (!profile) return fail('invalid profile');
    const osrmProfile = profile === 'car' ? 'driving' : profile;
    const pairs = (url.searchParams.get('coords') || '').split(';').map((s) => s.trim()).filter(Boolean);
    if (pairs.length < 2 || pairs.length > 12) return fail('need 2-12 coordinates');
    const clean = [];
    const pts = [];
    for (const pr of pairs) {
      const parts = pr.split(',');
      if (parts.length !== 2) return fail('invalid coordinate');
      const lon = Number(parts[0]);
      const lat = Number(parts[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return fail('invalid coordinate');
      }
      clean.push(`${lon},${lat}`);
      pts.push([lon, lat]);
    }
    let totalKm = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const legKm = haversineKm(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]);
      if (legKm > ROUTE_MAX_LEG_KM) return fail('route leg too long');
      totalKm += legKm;
    }
    if (totalKm > ROUTE_MAX_TOTAL_KM) return fail('route too long');
    const coords = clean.join(';');
    const cacheKey = `${profile}|${coords}`;
    const now = Date.now();
    const cached = _routeCache.get(cacheKey);
    if (cached && now - cached.cachedAt <= ROUTE_CACHE_MS) {
      res.status(200).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(cached.payload));
      return;
    }
    const upstream = `https://routing.openstreetmap.de/routed-${profile}/route/v1/${osrmProfile}/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
    let osrm;
    const upstreamRes = await fetch(upstream, {
      signal: AbortSignal.timeout(12000),
      headers: { 'User-Agent': 'gods-eye-view/vercel (deployed)' },
    });
    if (!upstreamRes.ok) return fail('no route found');
    const ctype = upstreamRes.headers.get('content-type') || '';
    if (!ctype.includes('json')) return fail('no route found');
    const text = await readResponseTextCapped(upstreamRes, ROUTE_MAX_RESPONSE_BYTES);
    osrm = JSON.parse(text);
    const route = osrm?.routes?.[0];
    if (osrm?.code !== 'Ok' || !route?.geometry?.coordinates?.length) return fail('no route found');
    const payload = {
      ok: true,
      profile,
      distanceM: Math.round(route.distance),
      durationS: Math.round(route.duration),
      geometry: route.geometry.coordinates,
    };
    _routeCache.set(cacheKey, { payload, cachedAt: now });
    if (_routeCache.size > 200) _routeCache.delete(_routeCache.keys().next().value);
    res.status(200).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(payload));
  } catch (e) {
    console.error('[Route Proxy]', e?.message || e);
    fail('route proxy error');
  }
}
