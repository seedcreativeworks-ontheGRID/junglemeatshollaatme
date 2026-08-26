/**
 * Consolidated hub for environment/context routes (Vercel Hobby plan's 12
 * Serverless Function cap forces route consolidation — see vercel.json
 * rewrites). Dispatches on `req.query.__r`.
 *
 * Routes folded in (original file → __r key):
 *   api/firms.js           → firms
 *   api/firms/status.js    → firms-status
 *   api/regional-brief.js  → regional-brief
 *   api/weather-effects.js → weather-effects
 */
import { parseFirmsCsv, filterTrailing24h } from '../src/data/firmsCsv.js';
import { coalesceProxyRequest } from './_lib/http.js';
import { fetchRegionalPlace, fetchRegionalWeather, fetchRegionalNews, validRegionalPoint, regionalBriefHasAnySource } from './_lib/regionalSources.js';

/** Folded in from api/firms.js (__r=firms). In-memory cache TTL 30 min. */
const FIRMS_TTL_MS = 30 * 60_000;
const FIRMS_SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT'];

let _firmsMem = null; // { at, sources, fires }
let _firmsInflight = null;

function firmsMapKey() {
  return String(process.env.FIRMS_MAP_KEY || '').trim();
}

async function fetchFirmsSource(key, source) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/world/2`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const records = parseFirmsCsv(await res.text());
  if (records === null) throw new Error('non-CSV upstream response');
  return records;
}

// Sequential (not parallel) fetches — quota courtesy, matching the original proxy.
async function refreshFirmsUpstream(key) {
  const now = Date.now();
  const sources = [];
  const fires = [];
  for (const source of FIRMS_SOURCES) {
    try {
      const records = filterTrailing24h(await fetchFirmsSource(key, source), now);
      sources.push({ source, count: records.length, ok: true });
      fires.push(...records);
    } catch (err) {
      console.warn(`[firms-proxy] ${source} fetch failed:`, err?.message || err);
      sources.push({ source, count: 0, ok: false });
    }
  }
  if (!sources.some((s) => s.ok)) throw new Error('all FIRMS sources failed');
  return { at: now, sources, fires };
}

function buildFirmsPayload(entry, stale) {
  const fires = filterTrailing24h(entry.fires, Date.now());
  return { fetchedAt: entry.at, stale, ttlMs: FIRMS_TTL_MS, sources: entry.sources, count: fires.length, fires };
}

async function handleFirms(req, res) {
  const sendJson = (status, obj) => {
    res.status(status).setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(obj));
  };
  try {
    const key = firmsMapKey();
    if (!key) { sendJson(503, { error: 'no_key' }); return; }

    const entry = _firmsMem;
    if (entry && Date.now() - entry.at < FIRMS_TTL_MS) {
      sendJson(200, buildFirmsPayload(entry, false));
      return;
    }
    if (!_firmsInflight) {
      _firmsInflight = refreshFirmsUpstream(key)
        .then((fresh) => { _firmsMem = fresh; return fresh; })
        .catch((err) => {
          console.warn(`[firms-proxy] refresh failed (${err?.message || err}) — serving cache if any`);
          return null;
        })
        .finally(() => { _firmsInflight = null; });
    }
    const fresh = await _firmsInflight;
    if (fresh) {
      sendJson(200, buildFirmsPayload(fresh, false));
    } else if (entry) {
      sendJson(200, buildFirmsPayload(entry, true));
    } else {
      sendJson(502, { error: 'firms fetch failed and no cache available' });
    }
  } catch (err) {
    console.warn('[firms-proxy] error:', err?.message || err);
    sendJson(500, { error: 'firms proxy error' });
  }
}

/**
 * Folded in from api/firms/status.js (__r=firms-status). NOTE: kept as an
 * independent cache (not shared with handleFirms above) — matching the
 * original two-separate-functions behavior where this had its own
 * independent 5-min TTL transaction-count cache.
 */
const FIRMS_STATUS_TTL_MS = 30 * 60_000;
const FIRMS_STATUS_CACHE_TTL_MS = 5 * 60_000;

let _firmsStatusCache = null;
let _firmsStatusInflight = null;

function getFirmsTransactions(key) {
  const now = Date.now();
  if (_firmsStatusCache && now - _firmsStatusCache.at < FIRMS_STATUS_CACHE_TTL_MS) return Promise.resolve(_firmsStatusCache.transactions);
  if (!_firmsStatusInflight) {
    _firmsStatusInflight = (async () => {
      try {
        const url = `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${encodeURIComponent(key)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const used = Number(body?.current_transactions);
        const limit = Number(body?.transaction_limit);
        return Number.isFinite(used) && Number.isFinite(limit) ? { used, limit } : null;
      } catch (err) {
        console.warn('[firms-proxy] mapkey status failed:', err?.message || err);
        return null;
      }
    })()
      .then((transactions) => { _firmsStatusCache = { at: Date.now(), transactions }; return transactions; })
      .finally(() => { _firmsStatusInflight = null; });
  }
  return _firmsStatusInflight;
}

async function handleFirmsStatus(req, res) {
  const sendJson = (status, obj) => {
    res.status(status).setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(obj));
  };
  try {
    const key = firmsMapKey();
    if (!key) {
      sendJson(200, { hasKey: false, lastFetch: null, count: null, stale: false, ttlMs: FIRMS_STATUS_TTL_MS, transactions: null });
      return;
    }
    const transactions = await getFirmsTransactions(key);
    sendJson(200, { hasKey: true, lastFetch: null, count: null, stale: false, ttlMs: FIRMS_STATUS_TTL_MS, transactions });
  } catch (err) {
    console.warn('[firms-proxy status] error:', err?.message || err);
    sendJson(500, { error: 'firms status proxy error' });
  }
}

/**
 * Folded in from api/regional-brief.js (__r=regional-brief). In-memory
 * cache TTL 5 min, serve-stale up to 60 min.
 */
const REGIONAL_BRIEF_CACHE_MS = 5 * 60_000;
const REGIONAL_BRIEF_STALE_MS = 60 * 60_000;
const REGIONAL_BRIEF_MAX_CACHE = 120;
const _regionalBriefCache = new Map();
const _regionalBriefInFlight = new Map();

function regionalBriefTrimCache() {
  while (_regionalBriefCache.size > REGIONAL_BRIEF_MAX_CACHE) {
    const oldest = _regionalBriefCache.keys().next().value;
    if (oldest === undefined) break;
    _regionalBriefCache.delete(oldest);
  }
}

async function refreshRegionalBrief(point, key) {
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
  _regionalBriefCache.set(key, { payload, cachedAt: Date.now() });
  regionalBriefTrimCache();
  return payload;
}

async function handleRegionalBrief(req, res) {
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
    const cached = _regionalBriefCache.get(key);
    if (cached && now - cached.cachedAt <= REGIONAL_BRIEF_CACHE_MS) {
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('X-Regional-Brief', 'HIT');
      res.send(JSON.stringify({ ...cached.payload, status: 'cached' }));
      return;
    }
    const request = coalesceProxyRequest(_regionalBriefInFlight, key, () => refreshRegionalBrief(point, key));
    try {
      const payload = await request.promise;
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('X-Regional-Brief', request.shared ? 'INFLIGHT' : 'MISS');
      res.send(JSON.stringify(payload));
    } catch {
      if (cached && now - cached.cachedAt <= REGIONAL_BRIEF_STALE_MS) {
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

/**
 * Folded in from api/weather-effects.js (__r=weather-effects). In-memory
 * cache TTL 5 min, serve-stale up to 30 min.
 */
const WEATHER_EFFECTS_CACHE_MS = 5 * 60_000;
const WEATHER_EFFECTS_STALE_MS = 30 * 60_000;
const WEATHER_EFFECTS_MAX_CACHE = 180;
const _weatherEffectsCache = new Map();
const _weatherEffectsInFlight = new Map();

function weatherEffectsTrimCache() {
  while (_weatherEffectsCache.size > WEATHER_EFFECTS_MAX_CACHE) {
    const oldest = _weatherEffectsCache.keys().next().value;
    if (oldest === undefined) break;
    _weatherEffectsCache.delete(oldest);
  }
}

async function refreshWeatherEffects(point, key) {
  const weather = await fetchRegionalWeather(point);
  if (!weather) throw new Error('Weather observation unavailable');
  const payload = { status: 'ready', retrievedAt: new Date().toISOString(), coordinates: point, weather };
  _weatherEffectsCache.set(key, { payload, cachedAt: Date.now() });
  weatherEffectsTrimCache();
  return payload;
}

async function handleWeatherEffects(req, res) {
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
    const cached = _weatherEffectsCache.get(key);
    if (cached && now - cached.cachedAt <= WEATHER_EFFECTS_CACHE_MS) {
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('X-Weather-Effects', 'HIT');
      res.send(JSON.stringify({ ...cached.payload, status: 'cached' }));
      return;
    }
    const request = coalesceProxyRequest(_weatherEffectsInFlight, key, () => refreshWeatherEffects(point, key));
    try {
      const payload = await request.promise;
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('X-Weather-Effects', request.shared ? 'INFLIGHT' : 'MISS');
      res.send(JSON.stringify(payload));
    } catch {
      if (cached && now - cached.cachedAt <= WEATHER_EFFECTS_STALE_MS) {
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

export default async function handler(req, res) {
  try {
    const route = req.query?.__r;
    if (route === 'firms') return handleFirms(req, res);
    if (route === 'firms-status') return handleFirmsStatus(req, res);
    if (route === 'regional-brief') return handleRegionalBrief(req, res);
    if (route === 'weather-effects') return handleWeatherEffects(req, res);
    res.status(404).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'unknown_route' }));
  } catch (err) {
    console.error('[environment hub]', err?.message || err);
    if (!res.headersSent) {
      res.status(500).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'internal_error', message: String(err?.message || err) }));
    }
  }
}
