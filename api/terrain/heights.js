/**
 * Vercel port of vite.config.js's terrainHeightsProxy() (/api/terrain/heights).
 * Reuses the pure helpers from src/data/terrainHeightsProxy.js (already
 * imported by vite.config.js for the same route). In-memory cache
 * (best-effort), TTL 30 days, keyed at 5-decimal precision.
 */
import {
  fetchTerrainChunkWithRetry,
  parseTerrainPoints,
  resolveTerrainHeightRequest,
  terrainPointKey,
} from '../../src/data/terrainHeightsProxy.js';

const TTL_MS = 30 * 24 * 3600_000;
const UPSTREAM_CHUNK = 256;
const MAX_POINTS = 2000;

const mem = new Map();
const inflight = new Map();

async function fetchUpstreamAll(points) {
  const results = [];
  for (let i = 0; i < points.length; i += UPSTREAM_CHUNK) {
    const chunk = points.slice(i, i + UPSTREAM_CHUNK);
    const chunkResults = await fetchTerrainChunkWithRetry(chunk);
    for (let j = 0; j < chunk.length; j += 1) results.push(chunkResults[j] ?? null);
  }
  return results;
}

function fetchMissingSingleFlight(points) {
  const key = points.map(terrainPointKey).join(';');
  if (!inflight.has(key)) {
    const request = fetchUpstreamAll(points).finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
    inflight.set(key, request);
  }
  return inflight.get(key);
}

export default async function handler(req, res) {
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
    if (points.length > MAX_POINTS) {
      send(500, { error: `too many points (${points.length}); max ${MAX_POINTS} per request` });
      return;
    }
    const outcome = await resolveTerrainHeightRequest({
      points,
      cache: mem,
      fetchMissing: fetchMissingSingleFlight,
      ttlMs: TTL_MS,
    });
    if (outcome.upstreamError) {
      console.warn(`[terrain-heights-proxy] refresh incomplete (${outcome.upstreamError?.message || outcome.upstreamError})`);
    }
    send(outcome.status, outcome.body);
  } catch (err) {
    send(500, { error: `terrain heights proxy error: ${err?.message || err}` });
  }
}
