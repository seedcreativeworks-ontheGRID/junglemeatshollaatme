/**
 * Vercel port of vite.config.js's trackBackfillProxies() /api/opensky-track
 * route (?icao24=hex6). OAuth via the shared coalesced token helper.
 * In-memory cache TTL 60s.
 */
import { getOpenSkyToken } from './_lib/openskyAuth.js';
import { readResponseTextCapped } from './_lib/http.js';

const TRACK_CACHE_MS = 60000;
const TRACK_CACHE_MAX = 200;
const RESPONSE_CAP_BYTES = 5 * 1024 * 1024;
const cache = new Map();

function cachePut(key, entry) {
  cache.set(key, entry);
  if (cache.size > TRACK_CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

async function proxyJson(res, key, upstreamUrl, headers = {}) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TRACK_CACHE_MS) {
    res.status(cached.status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(cached.body);
    return;
  }
  const upstream = await fetch(upstreamUrl, { headers, signal: AbortSignal.timeout(12000) });
  let body;
  try {
    const text = await readResponseTextCapped(upstream, RESPONSE_CAP_BYTES);
    body = upstream.ok ? text : JSON.stringify({ error: `Track source HTTP ${upstream.status}` });
  } catch {
    body = JSON.stringify({ error: 'Upstream track response too large' });
  }
  cachePut(key, { at: Date.now(), status: upstream.status, body });
  res.status(upstream.status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
}

export default async function handler(req, res) {
  try {
    const incoming = new URL(req.url || '', 'http://localhost');
    const icao24 = String(incoming.searchParams.get('icao24') || '').trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(icao24)) {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'icao24 must be a 6-char hex string' }));
      return;
    }
    const token = await getOpenSkyToken();
    await proxyJson(
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
