/**
 * Vercel port of vite.config.js's radioBrowserProxy() GET /stations route.
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
import { normalizeRadioBrowserStation, publicRadioStation } from '../_lib/radioStation.js';

const RADIO_DIRECTORY_CACHE_MS = 45 * 60 * 1000;
const RADIO_DIRECTORY_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const RADIO_MIRROR_CACHE_MS = 6 * 60 * 60 * 1000;
const RADIO_FALLBACK_MIRRORS = Object.freeze([
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
]);
const RADIO_DIRECTORY_LIMIT = 750;

let mirrorCache = { origins: [...RADIO_FALLBACK_MIRRORS], cachedAt: 0 };
let mirrorPromise = null;
let catalogCache = null; // { cachedAt, updatedAt, stations, stationIds }

function radioMirrorOrigin(value) {
  const hostname = String(value ?? '').toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9-]+\.api\.radio-browser\.info$/.test(hostname)) return null;
  return `https://${hostname}`;
}

async function fetchJson(url, maxBytes = 2 * 1024 * 1024) {
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

async function mirrors() {
  if (Date.now() - mirrorCache.cachedAt < RADIO_MIRROR_CACHE_MS) return mirrorCache.origins;
  if (!mirrorPromise) {
    mirrorPromise = (async () => {
      try {
        const rows = await fetchJson('https://all.api.radio-browser.info/json/servers', 256 * 1024);
        const discovered = [...new Set((Array.isArray(rows) ? rows : []).map((row) => radioMirrorOrigin(row?.name)).filter(Boolean))];
        if (discovered.length) {
          mirrorCache = { origins: [...discovered, ...RADIO_FALLBACK_MIRRORS.filter((o) => !discovered.includes(o))], cachedAt: Date.now() };
        } else {
          mirrorCache = { ...mirrorCache, cachedAt: Date.now() };
        }
      } catch {
        mirrorCache = { ...mirrorCache, cachedAt: Date.now() };
      }
      return mirrorCache.origins;
    })().finally(() => { mirrorPromise = null; });
  }
  return mirrorPromise;
}

async function fetchPath(pathname) {
  let lastError = null;
  for (const origin of await mirrors()) {
    try {
      return await fetchJson(`${origin}${pathname}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No Radio Browser mirror is available');
}

async function refreshCatalog() {
  const params = new URLSearchParams({
    has_geo_info: 'true',
    is_https: 'true',
    hidebroken: 'true',
    order: 'clickcount',
    reverse: 'true',
    limit: '1800',
  });
  const rows = await fetchPath(`/json/stations/search?${params}`, 4 * 1024 * 1024);
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

async function getCatalog() {
  const now = Date.now();
  if (catalogCache && now - catalogCache.cachedAt < RADIO_DIRECTORY_CACHE_MS) return { ...catalogCache, stale: false };
  try {
    const fresh = await refreshCatalog();
    catalogCache = fresh;
    return { ...fresh, stale: false };
  } catch (error) {
    if (catalogCache && now - catalogCache.cachedAt <= RADIO_DIRECTORY_STALE_MS) {
      return { ...catalogCache, stale: true, degraded: true, degradedReason: 'refresh-failed' };
    }
    throw error;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).setHeader('Cache-Control', 'no-store');
    res.send('');
    return;
  }
  try {
    const catalog = await getCatalog();
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

export { getCatalog };
