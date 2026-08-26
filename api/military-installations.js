/**
 * Vercel port of vite.config.js's militaryInstallationsProxy()
 * (/api/military-installations). Reuses the same Overpass-mirror fetch
 * helper as /api/overpass.js. In-memory cache, bbox snapped to a 0.05deg
 * grid for cache sharing unless exact=1.
 */
import { fetchOverpassPayload } from './overpass.js';
import { requiredFiniteQueryNumber, coalesceProxyRequest } from './_lib/http.js';

const CACHE_MS = 5 * 60_000;
const STALE_MS = 60 * 60_000;
const MAX_CACHE = 80;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const ELEMENT_CAP = 700;
const BBOX_STEP_DEG = 0.05;

const _cache = new Map();
const _inFlight = new Map();

function trimCache() {
  while (_cache.size > MAX_CACHE) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
}

function validBox(params) {
  const south = requiredFiniteQueryNumber(params, 'south');
  const west = requiredFiniteQueryNumber(params, 'west');
  const north = requiredFiniteQueryNumber(params, 'north');
  const east = requiredFiniteQueryNumber(params, 'east');
  if (![south, west, north, east].every(Number.isFinite)) return null;
  if (south < -90 || north > 90 || west < -180 || east > 180 || south >= north || west >= east) return null;
  if (north - south > 10 || east - west > 10) return null;
  return { south, west, north, east };
}

function quantizeBox(box, stepDeg = BBOX_STEP_DEG) {
  const snap = (value, roundFn) => roundFn(value / stepDeg) * stepDeg;
  return {
    south: snap(box.south, Math.floor),
    west: snap(box.west, Math.floor),
    north: snap(box.north, Math.ceil),
    east: snap(box.east, Math.ceil),
  };
}

function cacheKeyFor(box, decimals = 3) {
  return [box.south, box.west, box.north, box.east].map((v) => v.toFixed(decimals)).join(',');
}

async function refresh(box, key) {
  const bbox = `${box.south},${box.west},${box.north},${box.east}`;
  const ql = `[out:json][timeout:20];(nwr["military"~"^(airfield|naval_base|range|barracks|base)$"](${bbox});nwr["landuse"="military"](${bbox}););out center tags geom ${ELEMENT_CAP};`;
  const upstream = await fetchOverpassPayload(`data=${encodeURIComponent(ql)}`, MAX_RESPONSE_BYTES);
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
  _cache.set(key, entry);
  trimCache();
  return payload;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  const requested = validBox(url.searchParams);
  if (!requested) {
    res.status(400).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'A non-dateline bbox no larger than 10 degrees is required' }));
    return;
  }
  const exact = url.searchParams.get('exact') === '1';
  const box = exact ? requested : quantizeBox(requested);
  const key = exact ? `exact:${cacheKeyFor(box, 5)}` : cacheKeyFor(box);
  const now = Date.now();
  const cached = _cache.get(key);
  if (cached && now - cached.cachedAt <= CACHE_MS) {
    res.status(200).setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('X-Military-Installations', 'HIT');
    res.send(JSON.stringify({ ...cached.payload, status: 'cached' }));
    return;
  }
  const request = coalesceProxyRequest(_inFlight, key, () => refresh(box, key));
  try {
    const payload = await request.promise;
    res.status(200).setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('X-Military-Installations', request.shared ? 'INFLIGHT' : 'MISS');
    res.send(JSON.stringify(payload));
  } catch (error) {
    if (cached && now - cached.cachedAt <= STALE_MS) {
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
}
