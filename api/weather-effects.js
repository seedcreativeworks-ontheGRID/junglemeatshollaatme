/**
 * Vercel port of vite.config.js's weatherEffectsProxy() (/api/weather-effects).
 * In-memory cache TTL 5 min, serve-stale up to 30 min.
 */
import { coalesceProxyRequest } from './_lib/http.js';
import { fetchRegionalWeather, validRegionalPoint } from './_lib/regionalSources.js';

const CACHE_MS = 5 * 60_000;
const STALE_MS = 30 * 60_000;
const MAX_CACHE = 180;
const _cache = new Map();
const _inFlight = new Map();

function trimCache() {
  while (_cache.size > MAX_CACHE) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
}

async function refresh(point, key) {
  const weather = await fetchRegionalWeather(point);
  if (!weather) throw new Error('Weather observation unavailable');
  const payload = { status: 'ready', retrievedAt: new Date().toISOString(), coordinates: point, weather };
  _cache.set(key, { payload, cachedAt: Date.now() });
  trimCache();
  return payload;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.status(405).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }
    const url = new URL(req.url || '', 'http://localhost');
    const point = validRegionalPoint(url.searchParams);
    if (!point) {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'Valid latitude and longitude are required' }));
      return;
    }
    const key = `${(Math.round(point.latitude * 10) / 10).toFixed(1)},${(Math.round(point.longitude * 10) / 10).toFixed(1)}`;
    const now = Date.now();
    const cached = _cache.get(key);
    if (cached && now - cached.cachedAt <= CACHE_MS) {
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('X-Weather-Effects', 'HIT');
      res.send(JSON.stringify({ ...cached.payload, status: 'cached' }));
      return;
    }
    const request = coalesceProxyRequest(_inFlight, key, () => refresh(point, key));
    try {
      const payload = await request.promise;
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('X-Weather-Effects', request.shared ? 'INFLIGHT' : 'MISS');
      res.send(JSON.stringify(payload));
    } catch {
      if (cached && now - cached.cachedAt <= STALE_MS) {
        res.status(200).setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Weather-Effects', 'STALE');
        res.send(JSON.stringify({ ...cached.payload, status: 'stale' }));
        return;
      }
      res.status(503).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'Weather effects are temporarily unavailable' }));
    }
  } catch (error) {
    console.error('[weather-effects]', error?.message || error);
    if (!res.headersSent) {
      res.status(500).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'internal_error', message: String(error?.message || error) }));
    }
  }
}
