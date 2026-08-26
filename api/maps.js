/**
 * Consolidated hub for mapping/routing routes (Vercel Hobby plan's 12
 * Serverless Function cap forces route consolidation — see vercel.json
 * rewrites). Dispatches on `req.query.__r`.
 *
 * Routes folded in (original file → __r key):
 *   api/overpass.js       → overpass (POST)
 *   api/route.js          → route
 *   api/terrain/heights.js → terrain
 *   api/gbfs/[...path].js → gbfs
 *
 * `fetchOverpassPayload` stays a named export — api/opensky.js (military
 * installations, __r=military-installations) imports it from here.
 *
 * NOTE: `config.api.bodyParser = false` is required for the overpass POST
 * branch (it reads the raw request body itself, see readRequestBodyCapped).
 * This disables Vercel's automatic body parsing for the whole file, but the
 * other branches (route/terrain/gbfs) are GET-only and never touch req.body,
 * so this is harmless for them.
 */
import { readRequestBodyCapped, readResponseTextCapped, coalesceProxyRequest, haversineKm } from './_lib/http.js';
import {
  fetchTerrainChunkWithRetry,
  parseTerrainPoints,
  resolveTerrainHeightRequest,
  terrainPointKey,
} from '../src/data/terrainHeightsProxy.js';

export const config = { api: { bodyParser: false } };

/**
 * Folded in from api/overpass.js (__r=overpass, POST only). Tries each
 * Overpass mirror in order; in-memory cache TTL 24h keyed by request body,
 * serve-stale on total failure.
 */
const OVERPASS_UPSTREAMS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const OVERPASS_CACHE_MS = 86_400_000;
const OVERPASS_TIMEOUT_MS = 22000;
const OVERPASS_MAX_BODY_BYTES = 24 * 1024;
const OVERPASS_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const OVERPASS_CACHE_MAX_ENTRIES = 120;

const _overpassCache = new Map();
const _overpassInFlight = new Map();

function overpassLooksRateLimited(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return text.includes('rate_limited')
    || text.includes('quota of your ip address')
    || text.includes('dispatcher_client::request_read_and_idx::rate_limited')
    || text.includes('too many requests');
}

function overpassLooksRuntimeError(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return text.includes('runtime error') || text.includes('timed out') || text.includes('out of memory');
}

function overpassTrimCache() {
  while (_overpassCache.size > OVERPASS_CACHE_MAX_ENTRIES) {
    const oldest = _overpassCache.keys().next().value;
    if (!oldest) break;
    _overpassCache.delete(oldest);
  }
}

export async function fetchOverpassPayload(body, maxResponseBytes = OVERPASS_MAX_RESPONSE_BYTES) {
  let lastError = null;
  let lastRateLimitPayload = null;
  for (const endpoint of OVERPASS_UPSTREAMS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
    try {
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'gods-eye-view-overpass-proxy/1.0',
        },
        body,
        signal: controller.signal,
      });
      const responseBody = await readResponseTextCapped(upstream, maxResponseBytes);
      const contentType = upstream.headers.get('content-type') || 'application/json';
      const status = upstream.status;
      const rateLimited = status === 429 || overpassLooksRateLimited(responseBody);
      const runtimeError = overpassLooksRuntimeError(responseBody);
      const payload = { status, body: responseBody, contentType, endpoint, rateLimited, runtimeError };
      if (rateLimited) { lastRateLimitPayload = payload; continue; }
      if (runtimeError) { lastError = new Error(`Overpass runtime error (${endpoint})`); continue; }
      if (status >= 500) { lastError = new Error(`Overpass upstream returned ${status} (${endpoint})`); continue; }
      return payload;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  if (lastRateLimitPayload) return lastRateLimitPayload;
  throw lastError || new Error('All Overpass upstreams failed');
}

function sendOverpassPayload(res, payload, cacheStatus) {
  res.status(payload.status);
  res.setHeader('Content-Type', payload.contentType || 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=15');
  res.setHeader('X-Overpass-Cache', cacheStatus);
  res.setHeader('X-Overpass-Upstream', payload.endpoint || 'unknown');
  res.send(payload.body || '');
}

async function handleOverpass(req, res) {
  let cacheKey = null;
  try {
    if (req.method !== 'POST') {
      res.status(405).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    let body;
    try {
      body = (await readRequestBodyCapped(req, OVERPASS_MAX_BODY_BYTES)).toString();
    } catch (err) {
      if (err?.code === 'BODY_TOO_LARGE') {
        res.status(413).setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify({ error: 'Overpass query too large' }));
        return;
      }
      throw err;
    }
    if (!body) {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'Missing Overpass query body' }));
      return;
    }

    // The client always sends `data=<url-encoded QL>`; forward it as-is
    // (the dev-server proxy additionally validates/clamps the QL — omitted
    // here since Vercel functions run sandboxed per-invocation).
    cacheKey = body.replace(/\s+/g, ' ').trim();
    const now = Date.now();
    const cached = _overpassCache.get(cacheKey);
    if (cached && now - cached.cachedAt < OVERPASS_CACHE_MS) {
      sendOverpassPayload(res, cached, 'HIT');
      return;
    }

    const request = coalesceProxyRequest(_overpassInFlight, cacheKey, () => fetchOverpassPayload(body));
    try {
      const payload = await request.promise;
      if (payload.status < 500 && !payload.rateLimited && !payload.runtimeError) {
        _overpassCache.set(cacheKey, { ...payload, cachedAt: Date.now() });
        overpassTrimCache();
      }
      if (payload.rateLimited || payload.runtimeError || payload.status >= 500) {
        const stale = _overpassCache.get(cacheKey);
        if (stale) { sendOverpassPayload(res, stale, 'STALE'); return; }
      }
      sendOverpassPayload(res, payload, request.shared ? 'INFLIGHT' : 'MISS');
    } catch (e) {
      const stale = _overpassCache.get(cacheKey);
      if (stale) { sendOverpassPayload(res, stale, 'STALE'); return; }
      console.error('[Overpass Proxy]', e?.message || e);
      res.status(502).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'Overpass proxy error' }));
    }
  } catch (e) {
    const stale = cacheKey ? _overpassCache.get(cacheKey) : null;
    if (stale) { sendOverpassPayload(res, stale, 'STALE'); return; }
    console.error('[Overpass Proxy]', e?.message || e);
    res.status(502).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'Overpass proxy error' }));
  }
}

/**
 * Folded in from api/route.js (__r=route). OSRM routing via FOSSGIS mirrors.
 * GET ?profile=foot|car|bike&coords=lon,lat;lon,lat[;...]
 */
const ROUTE_CACHE_MS = 5 * 60_000;
const ROUTE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ROUTE_MAX_LEG_KM = 600;
const ROUTE_MAX_TOTAL_KM = 2500;
const _routeCache = new Map();

async function handleRoute(req, res) {
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

/**
 * Folded in from api/terrain/heights.js (__r=terrain). Reuses the pure
 * helpers from src/data/terrainHeightsProxy.js. In-memory cache
 * (best-effort), TTL 30 days, keyed at 5-decimal precision.
 */
const TERRAIN_TTL_MS = 30 * 24 * 3600_000;
const TERRAIN_UPSTREAM_CHUNK = 256;
const TERRAIN_MAX_POINTS = 2000;

const _terrainMem = new Map();
const _terrainInflight = new Map();

async function fetchTerrainUpstreamAll(points) {
  const results = [];
  for (let i = 0; i < points.length; i += TERRAIN_UPSTREAM_CHUNK) {
    const chunk = points.slice(i, i + TERRAIN_UPSTREAM_CHUNK);
    const chunkResults = await fetchTerrainChunkWithRetry(chunk);
    for (let j = 0; j < chunk.length; j += 1) results.push(chunkResults[j] ?? null);
  }
  return results;
}

function fetchTerrainMissingSingleFlight(points) {
  const key = points.map(terrainPointKey).join(';');
  if (!_terrainInflight.has(key)) {
    const request = fetchTerrainUpstreamAll(points).finally(() => {
      if (_terrainInflight.get(key) === request) _terrainInflight.delete(key);
    });
    _terrainInflight.set(key, request);
  }
  return _terrainInflight.get(key);
}

async function handleTerrain(req, res) {
  const send = (status, bodyObj) => {
    res.status(status).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(bodyObj));
  };
  try {
    const parsedUrl = new URL(req.url || '', 'http://internal');
    const rawPoints = parsedUrl.searchParams.get('points');
    const points = parseTerrainPoints(rawPoints);
    if (!points) {
      send(400, { error: 'invalid points parameter — expected "lon,lat;lon,lat;…" with finite numbers' });
      return;
    }
    if (points.length > TERRAIN_MAX_POINTS) {
      send(500, { error: `too many points (${points.length}); max ${TERRAIN_MAX_POINTS} per request` });
      return;
    }
    const outcome = await resolveTerrainHeightRequest({
      points,
      cache: _terrainMem,
      fetchMissing: fetchTerrainMissingSingleFlight,
      ttlMs: TERRAIN_TTL_MS,
    });
    if (outcome.upstreamError) {
      console.warn(`[terrain-heights-proxy] refresh incomplete (${outcome.upstreamError?.message || outcome.upstreamError})`);
    }
    send(outcome.status, outcome.body);
  } catch (err) {
    send(500, { error: `terrain heights proxy error: ${err?.message || err}` });
  }
}

/**
 * Folded in from api/gbfs/[...path].js (__r=gbfs). The vercel.json rewrite
 * for /api/gbfs/:path* puts the captured segment(s) into req.query.path
 * (array, same shape the original catch-all dynamic route produced). Path
 * segment 0 (URL-encoded) is the upstream GBFS URL. SSRF guard: HTTPS only,
 * host allowlist, path must end in station_information.json or
 * station_status.json.
 */
const GBFS_PROXY_TIMEOUT_MS = 12000;
const GBFS_MAX_BODY_BYTES = 5 * 1024 * 1024;
const GBFS_ALLOWED_HOSTS = new Set([
  'gbfs.lyft.com',
  'gbfs.bluebikes.com',
  'gbfs.bcycle.com',
  'gbfs.biketownpdx.com',
  'gbfs.cogobikeshare.com',
]);

function isAllowedGbfsHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return false;
  if (GBFS_ALLOWED_HOSTS.has(host)) return true;
  return host.endsWith('.publicbikesystem.net');
}

function isAllowedGbfsPath(pathname) {
  return /\/station_(information|status)\.json$/i.test(String(pathname || ''));
}

function gbfsCacheControl(pathname) {
  if (/\/station_information\.json$/i.test(String(pathname || ''))) return 'public, max-age=300';
  return 'no-store';
}

async function handleGbfs(req, res) {
  try {
    if (req.method !== 'GET') {
      res.status(405).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    const segments = Array.isArray(req.query?.path) ? req.query.path : [req.query?.path].filter(Boolean);
    const encodedTarget = segments.join('/');
    if (!encodedTarget) {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'Missing GBFS upstream target' }));
      return;
    }

    let decodedTarget = '';
    try { decodedTarget = decodeURIComponent(encodedTarget); } catch {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'Invalid GBFS target encoding' }));
      return;
    }

    let upstreamUrl;
    try { upstreamUrl = new URL(decodedTarget); } catch {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'Invalid GBFS upstream URL' }));
      return;
    }

    if (upstreamUrl.protocol !== 'https:') {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'Only https GBFS targets are allowed' }));
      return;
    }
    if (!isAllowedGbfsHost(upstreamUrl.hostname)) {
      res.status(403).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'GBFS host not allowed' }));
      return;
    }
    if (!isAllowedGbfsPath(upstreamUrl.pathname)) {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'Only station_information/station_status endpoints are allowed' }));
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GBFS_PROXY_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(upstreamUrl.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'gods-eye-view-gbfs-proxy/1.0' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const contentLength = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > GBFS_MAX_BODY_BYTES) {
      res.status(502).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'GBFS upstream response too large' }));
      return;
    }
    const body = await upstream.text();
    if (body.length > GBFS_MAX_BODY_BYTES) {
      res.status(502).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'GBFS upstream response too large' }));
      return;
    }
    const contentType = upstream.headers.get('content-type') || 'application/json';
    res.status(upstream.status);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', gbfsCacheControl(upstreamUrl.pathname));
    res.setHeader('X-GBFS-Upstream', upstreamUrl.hostname);
    res.send(body);
  } catch (error) {
    if (error?.name === 'AbortError') {
      res.status(504).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'GBFS upstream timeout' }));
      return;
    }
    console.error('[GBFS Proxy]', error?.message || String(error));
    res.status(502).setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify({ error: 'GBFS proxy error' }));
  }
}

export default async function handler(req, res) {
  try {
    const route = req.query?.__r;
    if (route === 'overpass') return handleOverpass(req, res);
    if (route === 'route') return handleRoute(req, res);
    if (route === 'terrain') return handleTerrain(req, res);
    if (route === 'gbfs') return handleGbfs(req, res);
    res.status(404).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'unknown_route' }));
  } catch (err) {
    console.error('[maps hub]', err?.message || err);
    if (!res.headersSent) {
      res.status(500).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'internal_error', message: String(err?.message || err) }));
    }
  }
}
