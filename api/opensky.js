/**
 * Consolidated hub for the flight-tracking routes (Vercel Hobby plan's 12
 * Serverless Function cap forces route consolidation — see vercel.json
 * rewrites). `/api/opensky` (this file's native route, no __r) is the
 * highest-traffic endpoint so it stays the default/no-dispatch-key branch;
 * every other flight-tracking route is reached via `?__r=<key>` injected by
 * a vercel.json rewrite and dispatched below.
 *
 * Routes folded in (original file → __r key):
 *   api/opensky-track.js        → track
 *   api/adsblol/mil.js          → adsblol-mil
 *   api/adsblol/trace.js        → adsblol-trace
 *   api/adsbdb/route/[callsign].js → adsbdb-route
 *   api/adsbdb/type/[hex].js    → adsbdb-type
 *   api/military-installations.js → military-installations
 */
import { getOpenSkyToken } from './_lib/openskyAuth.js';
import { readResponseJsonCapped, readResponseTextCapped, requiredFiniteQueryNumber, coalesceProxyRequest } from './_lib/http.js';
import { normalizeAdsbLolPointResponse } from '../src/data/adsbLolFallback.js';
import { fetchOverpassPayload } from './maps.js';

const OPENSKY_CACHE_MS = 9000;
const ADSBLOL_POINT_RADIUS_NM = 250;
const OPENSKY_AUTH_MODE_SET = new Set(['oauth', 'basic', 'auto', 'anon']);

let _cacheBody = null;
let _cacheStatus = 0;
let _cacheTime = 0;
let _cacheMeta = null;

function normalizeAuthMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  return OPENSKY_AUTH_MODE_SET.has(raw) ? raw : 'oauth';
}

function buildHeaders({ cacheStatus, requestedMode, usedMode, reason }) {
  return {
    'Cache-Control': 'no-store',
    'X-OpenSky-Cache': cacheStatus,
    'X-OpenSky-Auth': usedMode,
    'X-OpenSky-Auth-Mode-Requested': requestedMode,
    'X-OpenSky-Auth-Mode-Used': usedMode,
    'X-OpenSky-Auth-Reason': reason,
  };
}

async function fetchAdsbLolFallback(query) {
  const lat = Number(query.lat);
  const lon = Number(query.lon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  const roundedLat = Math.round(lat * 4) / 4;
  const roundedLon = Math.round(lon * 4) / 4;
  try {
    const upstream = await fetch(
      `https://api.adsb.lol/v2/lat/${roundedLat}/lon/${roundedLon}/dist/${ADSBLOL_POINT_RADIUS_NM}`,
      {
        headers: { Accept: 'application/json', 'User-Agent': 'gods-eye-view-adsblol-regional-fallback/1.0' },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!upstream.ok) return null;
    const payload = await readResponseJsonCapped(upstream, 8 * 1024 * 1024);
    const normalized = normalizeAdsbLolPointResponse(payload);
    return { body: JSON.stringify(normalized), count: normalized.states.length };
  } catch {
    return null;
  }
}

async function handleOpenSkyDefault(req, res) {
  try {
    const requestedMode = normalizeAuthMode(process.env.OPENSKY_AUTH_MODE);
    const now = Date.now();

    if (_cacheBody && now - _cacheTime < OPENSKY_CACHE_MS) {
      const meta = _cacheMeta || { requestedMode, usedMode: 'unknown', reason: 'cached' };
      res.status(_cacheStatus || 200);
      for (const [k, v] of Object.entries(buildHeaders({ cacheStatus: 'HIT', requestedMode: meta.requestedMode || requestedMode, usedMode: meta.usedMode, reason: meta.reason }))) {
        res.setHeader(k, v);
      }
      res.setHeader('Content-Type', 'application/json');
      res.send(_cacheBody);
      return;
    }

    const basicUser = process.env.OPENSKY_USERNAME || '';
    const basicPass = process.env.OPENSKY_PASSWORD || '';
    const hasBasicCreds = Boolean(basicUser && basicPass);
    const headers = { Accept: 'application/json' };
    let usedMode = 'anon';
    let reason = 'forced_anonymous';

    if (requestedMode === 'basic') {
      if (hasBasicCreds) {
        headers.Authorization = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`;
        usedMode = 'basic';
        reason = 'basic_credentials';
      } else {
        reason = 'missing_basic_creds';
      }
    } else if (requestedMode === 'oauth') {
      const token = await getOpenSkyToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
        usedMode = 'oauth';
        reason = 'oauth_token';
      } else {
        reason = 'oauth_invalid_or_missing';
      }
    } else if (requestedMode === 'auto') {
      const token = await getOpenSkyToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
        usedMode = 'oauth';
        reason = 'oauth_token';
      } else if (hasBasicCreds) {
        headers.Authorization = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`;
        usedMode = 'basic';
        reason = 'oauth_unavailable_fallback_basic';
      } else {
        reason = 'missing_oauth_and_basic_creds';
      }
    }

    let upstream = await fetch('https://opensky-network.org/api/states/all?extended=1', { headers, signal: AbortSignal.timeout(15000) });
    if ((upstream.status === 401 || upstream.status === 403) && requestedMode === 'auto' && usedMode === 'oauth' && hasBasicCreds) {
      upstream = await fetch('https://opensky-network.org/api/states/all?extended=1', {
        headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}` },
        signal: AbortSignal.timeout(15000),
      });
      usedMode = 'basic';
      reason = 'oauth_rejected_fallback_basic';
    }

    if (!upstream.ok) {
      const fallback = await fetchAdsbLolFallback(req.query || {});
      if (fallback) {
        res.status(200);
        for (const [k, v] of Object.entries(buildHeaders({ cacheStatus: 'MISS', requestedMode, usedMode: 'adsblol-regional', reason: `opensky_http_${upstream.status}_regional_fallback` }))) {
          res.setHeader(k, v);
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Flight-Source', 'adsb.lol');
        res.setHeader('X-Flight-Count', String(fallback.count));
        res.send(fallback.body);
        return;
      }
      if (_cacheBody) {
        res.status(200);
        for (const [k, v] of Object.entries(buildHeaders({ cacheStatus: 'STALE', requestedMode, usedMode, reason: 'upstream_failed_serving_stale' }))) {
          res.setHeader(k, v);
        }
        res.setHeader('Content-Type', 'application/json');
        res.send(_cacheBody);
        return;
      }
      let errorBody = { error: `OpenSky upstream returned HTTP ${upstream.status}` };
      if (upstream.status === 401 || upstream.status === 403) {
        errorBody = { error: 'OpenSky auth invalid or missing for the configured auth mode.' };
      }
      res.status(upstream.status || 502);
      for (const [k, v] of Object.entries(buildHeaders({ cacheStatus: 'NONE', requestedMode, usedMode, reason }))) res.setHeader(k, v);
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(errorBody));
      return;
    }

    const body = await upstream.text();
    _cacheBody = body;
    _cacheStatus = upstream.status;
    _cacheTime = now;
    _cacheMeta = { requestedMode, usedMode, reason };

    res.status(200);
    for (const [k, v] of Object.entries(buildHeaders({ cacheStatus: 'MISS', requestedMode, usedMode, reason }))) res.setHeader(k, v);
    res.setHeader('Content-Type', 'application/json');
    res.send(body);
  } catch (err) {
    console.error('[opensky proxy]', err?.message || err);
    if (_cacheBody) {
      res.status(200);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-OpenSky-Cache', 'STALE');
      res.send(_cacheBody);
      return;
    }
    res.status(502);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'OpenSky proxy error' }));
  }
}

/**
 * Folded in from api/opensky-track.js (__r=track). Vercel rewrite:
 * /api/opensky-track -> /api/opensky?__r=track (original ?icao24=... query
 * string passes through automatically).
 */
const TRACK_CACHE_MS = 60000;
const TRACK_CACHE_MAX = 200;
const TRACK_RESPONSE_CAP_BYTES = 5 * 1024 * 1024;
const _trackCache = new Map();

function trackCachePut(key, entry) {
  _trackCache.set(key, entry);
  if (_trackCache.size > TRACK_CACHE_MAX) {
    const oldest = [..._trackCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) _trackCache.delete(oldest[0]);
  }
}

async function trackProxyJson(res, key, upstreamUrl, headers = {}) {
  const cached = _trackCache.get(key);
  if (cached && Date.now() - cached.at < TRACK_CACHE_MS) {
    res.status(cached.status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(cached.body);
    return;
  }
  const upstream = await fetch(upstreamUrl, { headers, signal: AbortSignal.timeout(12000) });
  let body;
  try {
    const text = await readResponseTextCapped(upstream, TRACK_RESPONSE_CAP_BYTES);
    body = upstream.ok ? text : JSON.stringify({ error: `Track source HTTP ${upstream.status}` });
  } catch {
    body = JSON.stringify({ error: 'Upstream track response too large' });
  }
  trackCachePut(key, { at: Date.now(), status: upstream.status, body });
  res.status(upstream.status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
}

async function handleOpenSkyTrack(req, res) {
  try {
    const incoming = new URL(req.url || '', 'http://localhost');
    const icao24 = String(incoming.searchParams.get('icao24') || '').trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(icao24)) {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'icao24 must be a 6-char hex string' }));
      return;
    }
    const token = await getOpenSkyToken();
    await trackProxyJson(
      res,
      `osky:${icao24}`,
      `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`,
      token ? { Authorization: `Bearer ${token}` } : {},
    );
  } catch (error) {
    res.status(502).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'OpenSky track fetch failed' }));
  }
}

/** Folded in from api/adsblol/mil.js (__r=adsblol-mil). */
const ADSBLOL_MIL_CACHE_MS = 12000;
let _adsblolMilCache = null;
let _adsblolMilCacheAt = 0;

async function handleAdsbLolMil(req, res) {
  try {
    const now = Date.now();
    if (_adsblolMilCache && now - _adsblolMilCacheAt < ADSBLOL_MIL_CACHE_MS) {
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-ADS-B-Cache', 'HIT');
      res.send(_adsblolMilCache);
      return;
    }
    const upstream = await fetch('https://api.adsb.lol/v2/mil', {
      headers: { 'User-Agent': 'gods-eye-view-adsblol-proxy/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    const body = await upstream.text();
    if (upstream.ok) {
      _adsblolMilCache = body;
      _adsblolMilCacheAt = now;
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-ADS-B-Cache', 'MISS');
      res.send(body);
      return;
    }
    if (_adsblolMilCache) {
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-ADS-B-Cache', 'STALE-ERROR');
      res.send(_adsblolMilCache);
      return;
    }
    res.status(upstream.status).setHeader('Content-Type', 'application/json');
    res.send(body);
  } catch (err) {
    if (_adsblolMilCache) {
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-ADS-B-Cache', 'STALE-ERROR');
      res.send(_adsblolMilCache);
      return;
    }
    console.error('[adsblol mil proxy]', err?.message || err);
    res.status(502).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'adsb.lol proxy error' }));
  }
}

/** Folded in from api/adsblol/trace.js (__r=adsblol-trace, ?hex=...). */
const ADSBLOL_TRACE_CACHE_MS = 60000;
const ADSBLOL_TRACE_CACHE_MAX = 200;
const ADSBLOL_TRACE_RESPONSE_CAP_BYTES = 5 * 1024 * 1024;
const _adsblolTraceCache = new Map();

function adsblolTraceCachePut(key, entry) {
  _adsblolTraceCache.set(key, entry);
  if (_adsblolTraceCache.size > ADSBLOL_TRACE_CACHE_MAX) {
    const oldest = [..._adsblolTraceCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) _adsblolTraceCache.delete(oldest[0]);
  }
}

async function handleAdsbLolTrace(req, res) {
  try {
    const incoming = new URL(req.url || '', 'http://localhost');
    const hex = String(incoming.searchParams.get('hex') || '').trim().toLowerCase();
    if (!/^[0-9a-f~]{6,7}$/.test(hex)) {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'hex must be a 6-7 char hex string' }));
      return;
    }
    const key = `lol:${hex}`;
    const cached = _adsblolTraceCache.get(key);
    if (cached && Date.now() - cached.at < ADSBLOL_TRACE_CACHE_MS) {
      res.status(cached.status).setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(cached.body);
      return;
    }
    const upstream = await fetch(
      `https://adsb.lol/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`,
      { signal: AbortSignal.timeout(12000) },
    );
    let body;
    try {
      const text = await readResponseTextCapped(upstream, ADSBLOL_TRACE_RESPONSE_CAP_BYTES);
      body = upstream.ok ? text : JSON.stringify({ error: `Track source HTTP ${upstream.status}` });
    } catch {
      body = JSON.stringify({ error: 'Upstream track response too large' });
    }
    adsblolTraceCachePut(key, { at: Date.now(), status: upstream.status, body });
    res.status(upstream.status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  } catch (error) {
    res.status(502).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'adsb.lol trace fetch failed' }));
  }
}

/**
 * Folded in from api/adsbdb/route/[callsign].js (__r=adsbdb-route). The
 * vercel.json rewrite puts the captured :callsign into req.query.callsign.
 */
const ADSBDB_ROUTE_TTL_MS = 24 * 3600_000;
const _adsbdbRouteCache = new Map(); // callsign -> { at, data }
const _adsbdbRouteInflight = new Map();

const adsbdbFresh = (e) => e && Date.now() - e.at < ADSBDB_ROUTE_TTL_MS;

function parseAdsbdbRoute(json) {
  const fr = json?.response?.flightroute;
  if (!fr?.origin || !fr?.destination) return null;
  const airport = (a) => ({
    code: a.iata_code || a.icao_code || '',
    name: a.municipality || a.name || '',
    lat: Number.isFinite(a.latitude) ? a.latitude : null,
    lon: Number.isFinite(a.longitude) ? a.longitude : null,
  });
  return { airline: fr.airline?.name || null, origin: airport(fr.origin), destination: airport(fr.destination) };
}

function adsbdbRouteLookup(cs) {
  if (adsbdbFresh(_adsbdbRouteCache.get(cs))) return Promise.resolve(_adsbdbRouteCache.get(cs).data);
  if (!_adsbdbRouteInflight.has(cs)) {
    _adsbdbRouteInflight.set(cs, (async () => {
      try {
        const res = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = parseAdsbdbRoute(await res.json());
          _adsbdbRouteCache.set(cs, { at: Date.now(), data });
          return data;
        }
        if (res.status === 404) {
          _adsbdbRouteCache.set(cs, { at: Date.now(), data: null });
        }
        const entry = _adsbdbRouteCache.get(cs);
        return adsbdbFresh(entry) ? entry.data : null;
      } catch {
        const entry = _adsbdbRouteCache.get(cs);
        return adsbdbFresh(entry) ? entry.data : null;
      } finally {
        _adsbdbRouteInflight.delete(cs);
      }
    })());
  }
  return _adsbdbRouteInflight.get(cs);
}

async function handleAdsbdbRoute(req, res) {
  const send = (status, obj) => {
    res.status(status).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(obj));
  };
  try {
    const cs = String(req.query?.callsign || '').toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(cs)) return send(400, { error: 'invalid callsign' });
    const data = await adsbdbRouteLookup(cs);
    return send(200, data ? { found: true, ...data } : { found: false });
  } catch (err) {
    return send(500, { error: String(err?.message || err) });
  }
}

/**
 * Folded in from api/adsbdb/type/[hex].js (__r=adsbdb-type). The vercel.json
 * rewrite puts the captured :hex into req.query.hex.
 */
const ADSBDB_TYPE_TTL_MS = 24 * 3600_000;
const _adsbdbTypeCache = new Map(); // hex -> { at, data }
const _adsbdbTypeInflight = new Map();

const adsbdbTypeFresh = (e) => e && Date.now() - e.at < ADSBDB_TYPE_TTL_MS;

function parseAdsbdbAircraft(json) {
  const a = json?.response?.aircraft;
  if (!a) return null;
  return {
    typeCode: a.icao_type || null,
    typeName: a.manufacturer && a.type ? `${a.manufacturer} ${a.type}` : (a.type || null),
    registration: a.registration || null,
  };
}

function adsbdbTypeLookup(hex) {
  if (adsbdbTypeFresh(_adsbdbTypeCache.get(hex))) return Promise.resolve(_adsbdbTypeCache.get(hex).data);
  if (!_adsbdbTypeInflight.has(hex)) {
    _adsbdbTypeInflight.set(hex, (async () => {
      try {
        const res = await fetch(`https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(hex)}`, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = parseAdsbdbAircraft(await res.json());
          _adsbdbTypeCache.set(hex, { at: Date.now(), data });
          return data;
        }
        if (res.status === 404) {
          _adsbdbTypeCache.set(hex, { at: Date.now(), data: null });
        }
        const entry = _adsbdbTypeCache.get(hex);
        return adsbdbTypeFresh(entry) ? entry.data : null;
      } catch {
        const entry = _adsbdbTypeCache.get(hex);
        return adsbdbTypeFresh(entry) ? entry.data : null;
      } finally {
        _adsbdbTypeInflight.delete(hex);
      }
    })());
  }
  return _adsbdbTypeInflight.get(hex);
}

async function handleAdsbdbType(req, res) {
  const send = (status, obj) => {
    res.status(status).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(obj));
  };
  try {
    const hex = String(req.query?.hex || '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) return send(400, { error: 'invalid hex' });
    const data = await adsbdbTypeLookup(hex);
    return send(200, data ? { found: true, ...data } : { found: false });
  } catch (err) {
    return send(500, { error: String(err?.message || err) });
  }
}

/**
 * Folded in from api/military-installations.js (__r=military-installations).
 * Reuses fetchOverpassPayload from api/maps.js (where api/overpass.js's
 * logic now lives).
 */
const MIL_CACHE_MS = 5 * 60_000;
const MIL_STALE_MS = 60 * 60_000;
const MIL_MAX_CACHE = 80;
const MIL_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const ELEMENT_CAP = 700;
const MIL_BBOX_STEP_DEG = 0.05;

const _milCache = new Map();
const _milInFlight = new Map();

function milTrimCache() {
  while (_milCache.size > MIL_MAX_CACHE) {
    const oldest = _milCache.keys().next().value;
    if (oldest === undefined) break;
    _milCache.delete(oldest);
  }
}

function milValidBox(params) {
  const south = requiredFiniteQueryNumber(params, 'south');
  const west = requiredFiniteQueryNumber(params, 'west');
  const north = requiredFiniteQueryNumber(params, 'north');
  const east = requiredFiniteQueryNumber(params, 'east');
  if (![south, west, north, east].every(Number.isFinite)) return null;
  if (south < -90 || north > 90 || west < -180 || east > 180 || south >= north || west >= east) return null;
  if (north - south > 10 || east - west > 10) return null;
  return { south, west, north, east };
}

function milQuantizeBox(box, stepDeg = MIL_BBOX_STEP_DEG) {
  const snap = (value, roundFn) => roundFn(value / stepDeg) * stepDeg;
  return {
    south: snap(box.south, Math.floor),
    west: snap(box.west, Math.floor),
    north: snap(box.north, Math.ceil),
    east: snap(box.east, Math.ceil),
  };
}

function milCacheKeyFor(box, decimals = 3) {
  return [box.south, box.west, box.north, box.east].map((v) => v.toFixed(decimals)).join(',');
}

async function milRefresh(box, key) {
  const bbox = `${box.south},${box.west},${box.north},${box.east}`;
  const ql = `[out:json][timeout:20];(nwr["military"~"^(airfield|naval_base|range|barracks|base)$"](${bbox});nwr["landuse"="military"](${bbox}););out center tags geom ${ELEMENT_CAP};`;
  const upstream = await fetchOverpassPayload(`data=${encodeURIComponent(ql)}`, MIL_MAX_RESPONSE_BYTES);
  if (upstream.status >= 400 || upstream.rateLimited || upstream.runtimeError) {
    throw new Error('Mapped installation upstream unavailable');
  }
  const parsed = JSON.parse(upstream.body);
  const elements = Array.isArray(parsed?.elements) ? parsed.elements.slice(0, ELEMENT_CAP) : [];
  const payload = {
    elements,
    saturated: elements.length >= ELEMENT_CAP,
    elementCap: ELEMENT_CAP,
    retrievedAt: new Date().toISOString(),
    status: 'ready',
  };
  const entry = { payload, cachedAt: Date.now() };
  _milCache.set(key, entry);
  milTrimCache();
  return payload;
}

async function handleMilitaryInstallations(req, res) {
  try {
    if (req.method !== 'GET') {
      res.status(405).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const requested = milValidBox(url.searchParams);
    if (!requested) {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'A non-dateline bbox no larger than 10 degrees is required' }));
      return;
    }
    const exact = url.searchParams.get('exact') === '1';
    const box = exact ? requested : milQuantizeBox(requested);
    const key = exact ? `exact:${milCacheKeyFor(box, 5)}` : milCacheKeyFor(box);
    const now = Date.now();
    const cached = _milCache.get(key);
    if (cached && now - cached.cachedAt <= MIL_CACHE_MS) {
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('X-Military-Installations', 'HIT');
      res.send(JSON.stringify({ ...cached.payload, status: 'cached' }));
      return;
    }
    const request = coalesceProxyRequest(_milInFlight, key, () => milRefresh(box, key));
    try {
      const payload = await request.promise;
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('X-Military-Installations', request.shared ? 'INFLIGHT' : 'MISS');
      res.send(JSON.stringify(payload));
    } catch (error) {
      if (cached && now - cached.cachedAt <= MIL_STALE_MS) {
        res.status(200).setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Military-Installations', 'STALE');
        res.send(JSON.stringify({ ...cached.payload, status: 'stale' }));
        return;
      }
      res.status(503).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'Mapped installation context is temporarily unavailable' }));
    }
  } catch (error) {
    console.error('[military-installations]', error?.message || error);
    if (!res.headersSent) {
      res.status(500).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'internal_error', message: String(error?.message || error) }));
    }
  }
}

export default async function handler(req, res) {
  try {
    const route = req.query?.__r;
    if (!route) return handleOpenSkyDefault(req, res);
    if (route === 'track') return handleOpenSkyTrack(req, res);
    if (route === 'adsblol-mil') return handleAdsbLolMil(req, res);
    if (route === 'adsblol-trace') return handleAdsbLolTrace(req, res);
    if (route === 'adsbdb-route') return handleAdsbdbRoute(req, res);
    if (route === 'adsbdb-type') return handleAdsbdbType(req, res);
    if (route === 'military-installations') return handleMilitaryInstallations(req, res);
    res.status(404).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'unknown_route' }));
  } catch (err) {
    console.error('[opensky hub]', err?.message || err);
    if (!res.headersSent) {
      res.status(500).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'internal_error', message: String(err?.message || err) }));
    }
  }
}
