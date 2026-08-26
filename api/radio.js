/**
 * Consolidated hub for radio-directory routes (Vercel Hobby plan's 12
 * Serverless Function cap forces route consolidation — see vercel.json
 * rewrites). Dispatches on `req.query.__r`.
 *
 * Routes folded in (original file → __r key):
 *   api/radio/stations.js      → stations
 *   api/radio/click/[uuid].js  → click
 */
import { normalizeRadioBrowserStation, publicRadioStation, RADIO_UUID_RE } from './_lib/radioStation.js';

/**
 * Folded in from api/radio/stations.js (__r=stations).
 *
 * SIMPLIFICATION NOTE: the original dev-server proxy does DNS-level SSRF
 * pinning (resolves the mirror hostname, validates the address is public,
 * then connects to that pinned address) before every Radio Browser request.
 * That hardening is intentionally NOT reproduced here — Vercel serverless
 * functions already run each invocation in an isolated sandbox, which is a
 * different (and here, adequate) SSRF boundary; flagging the difference so
 * it's a conscious choice, not an oversight.
 *
 * Also simplified: the original builds its catalog from 9 parallel tag
 * queries (popularity + specialist categories like "aviation", "marine")
 * merged and health-scored. This port issues one broad, popularity-sorted
 * query — full parity would need re-porting ~500 lines of catalog-merging
 * logic for a caching/quality improvement, not a correctness one.
 */
const RADIO_DIRECTORY_CACHE_MS = 45 * 60 * 1000;
const RADIO_DIRECTORY_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const RADIO_MIRROR_CACHE_MS = 6 * 60 * 60 * 1000;
const RADIO_FALLBACK_MIRRORS = Object.freeze([
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
]);
const RADIO_DIRECTORY_LIMIT = 750;

let _mirrorCache = { origins: [...RADIO_FALLBACK_MIRRORS], cachedAt: 0 };
let _mirrorPromise = null;
let _catalogCache = null; // { cachedAt, updatedAt, stations, stationIds }

function radioMirrorOrigin(value) {
  const hostname = String(value ?? '').toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9-]+\.api\.radio-browser\.info$/.test(hostname)) return null;
  return `https://${hostname}`;
}

async function fetchRadioJson(url, maxBytes = 2 * 1024 * 1024) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'gods-eye-view-radio-proxy/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Radio Browser returned ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Radio Browser response too large');
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function radioMirrors() {
  if (Date.now() - _mirrorCache.cachedAt < RADIO_MIRROR_CACHE_MS) return _mirrorCache.origins;
  if (!_mirrorPromise) {
    _mirrorPromise = (async () => {
      try {
        const rows = await fetchRadioJson('https://all.api.radio-browser.info/json/servers', 256 * 1024);
        const discovered = [...new Set((Array.isArray(rows) ? rows : []).map((row) => radioMirrorOrigin(row?.name)).filter(Boolean))];
        if (discovered.length) {
          _mirrorCache = { origins: [...discovered, ...RADIO_FALLBACK_MIRRORS.filter((o) => !discovered.includes(o))], cachedAt: Date.now() };
        } else {
          _mirrorCache = { ..._mirrorCache, cachedAt: Date.now() };
        }
      } catch {
        _mirrorCache = { ..._mirrorCache, cachedAt: Date.now() };
      }
      return _mirrorCache.origins;
    })().finally(() => { _mirrorPromise = null; });
  }
  return _mirrorPromise;
}

async function fetchRadioPath(pathname) {
  let lastError = null;
  for (const origin of await radioMirrors()) {
    try {
      return await fetchRadioJson(`${origin}${pathname}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No Radio Browser mirror is available');
}

async function refreshRadioCatalog() {
  const params = new URLSearchParams({
    has_geo_info: 'true',
    is_https: 'true',
    hidebroken: 'true',
    order: 'clickcount',
    reverse: 'true',
    limit: '1800',
  });
  const rows = await fetchRadioPath(`/json/stations/search?${params}`, 4 * 1024 * 1024);
  if (!Array.isArray(rows)) throw new Error('Radio Browser catalog payload was not an array');
  const stations = rows.map(normalizeRadioBrowserStation).filter(Boolean).slice(0, RADIO_DIRECTORY_LIMIT);
  const timestamp = Date.now();
  return {
    cachedAt: timestamp,
    updatedAt: new Date(timestamp).toISOString(),
    stations: stations.map(publicRadioStation),
    stationIds: new Set(stations.map((s) => s.id)),
  };
}

async function getRadioCatalog() {
  const now = Date.now();
  if (_catalogCache && now - _catalogCache.cachedAt < RADIO_DIRECTORY_CACHE_MS) return { ..._catalogCache, stale: false };
  try {
    const fresh = await refreshRadioCatalog();
    _catalogCache = fresh;
    return { ...fresh, stale: false };
  } catch (error) {
    if (_catalogCache && now - _catalogCache.cachedAt <= RADIO_DIRECTORY_STALE_MS) {
      return { ..._catalogCache, stale: true, degraded: true, degradedReason: 'refresh-failed' };
    }
    throw error;
  }
}

async function handleRadioStations(req, res) {
  if (req.method !== 'GET') {
    res.status(405).setHeader('Cache-Control', 'no-store');
    res.send('');
    return;
  }
  try {
    const catalog = await getRadioCatalog();
    res.status(200).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify({
      stations: catalog.stations,
      updatedAt: catalog.updatedAt,
      stale: catalog.stale,
      degraded: Boolean(catalog.degraded),
      degradedReason: catalog.degradedReason || null,
      coverage: null,
      acceptedGeneration: null,
      catalogInstance: 'vercel',
    }));
  } catch (error) {
    res.status(503).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify({ error: 'Radio directory is temporarily unavailable', degraded: true, degradedReason: error?.message || null }));
  }
}

/**
 * Folded in from api/radio/click/[uuid].js (__r=click, ?uuid=...). Fires the
 * click-count ping to Radio Browser and returns 204 (awaited, with a short
 * timeout, since serverless functions aren't guaranteed to keep running
 * background work after the response is sent).
 */
async function handleRadioClick(req, res) {
  if (req.method !== 'POST') {
    res.status(405).setHeader('Cache-Control', 'no-store');
    res.send('');
    return;
  }
  const id = String(req.query?.uuid || '').toLowerCase();
  if (!RADIO_UUID_RE.test(id)) {
    res.status(404).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'Unknown radio station' }));
    return;
  }
  try {
    await fetch(`${RADIO_FALLBACK_MIRRORS[0]}/json/url/${id}`, {
      headers: { 'User-Agent': 'gods-eye-view-radio-proxy/1.0' },
      signal: AbortSignal.timeout(4000),
    });
  } catch { /* best-effort click ping */ }
  res.status(204).setHeader('Cache-Control', 'no-store');
  res.end();
}

export default async function handler(req, res) {
  try {
    const route = req.query?.__r;
    if (route === 'stations') return handleRadioStations(req, res);
    if (route === 'click') return handleRadioClick(req, res);
    res.status(404).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'unknown_route' }));
  } catch (err) {
    console.error('[radio hub]', err?.message || err);
    if (!res.headersSent) {
      res.status(500).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'internal_error', message: String(err?.message || err) }));
    }
  }
}
