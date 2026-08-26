/**
 * Vercel port of vite.config.js's rocketLaunchesProxy() (/api/launches).
 * Upstream: Launch Library 2 (ll.thespacedevs.com). In-memory cache TTL 15 min.
 */
const TTL_MS = 15 * 60_000;
let cache = null; // { at, body }
let inflight = null;

function requestHeaders() {
  const token = String(process.env.LL2_API_TOKEN || '').trim();
  return { Accept: 'application/json', ...(token ? { Authorization: `Token ${token}` } : {}) };
}

async function refreshUpstream() {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86400000);
  const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
  url.searchParams.set('net__gte', start.toISOString());
  url.searchParams.set('net__lte', end.toISOString());
  url.searchParams.set('limit', '100');
  url.searchParams.set('mode', 'detailed');
  const upstream = await fetch(url, { signal: AbortSignal.timeout(20000), headers: requestHeaders() });
  const body = await upstream.text();
  if (!upstream.ok) {
    const error = new Error(`upstream HTTP ${upstream.status}`);
    error.upstreamStatus = upstream.status;
    error.upstreamBody = body;
    throw error;
  }
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed?.results)) throw new Error('malformed upstream response');
  const fresh = { at: Date.now(), body };
  cache = fresh;
  return fresh;
}

function send(res, status, body, cacheState) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', status === 200 ? 'public, max-age=900' : 'no-store');
  res.setHeader('X-GEV-Cache', cacheState);
  res.send(body);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    send(res, 405, JSON.stringify({ error: 'Method Not Allowed' }), 'NONE');
    return;
  }
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) {
    send(res, 200, cache.body, 'HIT');
    return;
  }
  const stale = cache;
  if (!inflight) {
    inflight = refreshUpstream().finally(() => { inflight = null; });
  }
  try {
    const fresh = await inflight;
    send(res, 200, fresh.body, 'MISS');
  } catch (error) {
    if (stale) {
      console.warn(`[launch-library-proxy] refresh failed (${error?.message || error}) — serving stale cache`);
      send(res, 200, stale.body, 'STALE-ERROR');
      return;
    }
    send(
      res,
      Number.isInteger(error?.upstreamStatus) ? error.upstreamStatus : 502,
      error?.upstreamBody || JSON.stringify({ error: 'Launch Library 2 unavailable' }),
      'NONE',
    );
  }
}
