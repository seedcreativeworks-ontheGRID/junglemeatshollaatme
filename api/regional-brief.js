/**
 * Vercel port of vite.config.js's regionalBriefProxy() (/api/regional-brief).
 * In-memory cache TTL 5 min, serve-stale up to 60 min.
 */
import { coalesceProxyRequest } from './_lib/http.js';
import { fetchRegionalPlace, fetchRegionalWeather, fetchRegionalNews, validRegionalPoint, regionalBriefHasAnySource } from './_lib/regionalSources.js';

const CACHE_MS = 5 * 60_000;
const STALE_MS = 60 * 60_000;
const MAX_CACHE = 120;
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
  const [placeResult, weatherResult] = await Promise.allSettled([
    fetchRegionalPlace(point),
    fetchRegionalWeather(point),
  ]);
  const place = placeResult.status === 'fulfilled' ? placeResult.value : null;
  const weather = weatherResult.status === 'fulfilled' ? weatherResult.value : null;
  const news = await fetchRegionalNews(place);
  if (!regionalBriefHasAnySource({ place, weather, news })) {
    throw new Error('All regional briefing sources unavailable');
  }
  const payload = {
    status: place && weather && news.status !== 'unavailable' ? 'ready' : 'partial',
    retrievedAt: new Date().toISOString(),
    coordinates: point,
    place,
    placeStatus: place ? 'ready' : 'unavailable',
    weather,
    weatherStatus: weather ? 'ready' : 'unavailable',
    newsStatus: news.status,
    newsQuery: news.query,
    newsSource: news.source,
    articles: news.articles,
  };
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
      res.setHeader('X-Regional-Brief', 'HIT');
      res.send(JSON.stringify({ ...cached.payload, status: 'cached' }));
      return;
    }
    const request = coalesceProxyRequest(_inFlight, key, () => refresh(point, key));
    try {
      const payload = await request.promise;
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('X-Regional-Brief', request.shared ? 'INFLIGHT' : 'MISS');
      res.send(JSON.stringify(payload));
    } catch {
      if (cached && now - cached.cachedAt <= STALE_MS) {
        res.status(200).setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Regional-Brief', 'STALE');
        res.send(JSON.stringify({ ...cached.payload, status: 'stale' }));
        return;
      }
      res.status(503).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'Regional briefing is temporarily unavailable' }));
    }
  } catch (error) {
    console.error('[regional-brief]', error?.message || error);
    if (!res.headersSent) {
      res.status(500).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'internal_error', message: String(error?.message || error) }));
    }
  }
}
