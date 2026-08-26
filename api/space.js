/**
 * Consolidated hub for space-tracking routes (Vercel Hobby plan's 12
 * Serverless Function cap forces route consolidation — see vercel.json
 * rewrites). Dispatches on `req.query.__r`.
 *
 * Routes folded in (original file → __r key):
 *   api/celestrak/[group].js → celestrak
 *   api/launches.js          → launches
 */

/**
 * Folded in from api/celestrak/[group].js (__r=celestrak). The vercel.json
 * rewrite puts the captured :group into req.query.group.
 * Upstream: https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=tle
 * In-memory cache (best-effort, see api/_lib/http.js), TTL 6h, serve-stale on failure.
 */
const TLE_TTL_MS = 6 * 3600_000;
const _celestrakMem = new Map(); // group -> { at, body }
const _celestrakInflight = new Map();

async function fetchCelestrakUpstream(group) {
  const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
  url.searchParams.set('GROUP', group);
  url.searchParams.set('FORMAT', 'tle');
  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': 'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  if (!/^1 /m.test(body)) throw new Error('no TLE lines in response');
  return { at: Date.now(), body };
}

async function handleCelestrak(req, res) {
  const group = String(req.query?.group || '');
  if (!/^[a-z0-9-]+$/i.test(group)) {
    res.status(400).setHeader('Content-Type', 'text/plain');
    res.send('invalid group');
    return;
  }

  const send = (status, body, cacheStatus) => {
    res.status(status);
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('x-tle-cache', cacheStatus);
    res.send(body);
  };

  try {
    const now = Date.now();
    const entry = _celestrakMem.get(group);
    if (entry && now - entry.at < TLE_TTL_MS) {
      send(200, entry.body, 'HIT');
      return;
    }
    if (!_celestrakInflight.has(group)) {
      _celestrakInflight.set(group, fetchCelestrakUpstream(group)
        .then((fresh) => { _celestrakMem.set(group, fresh); return fresh; })
        .catch((err) => {
          console.warn(`[celestrak-proxy] ${group} refresh failed (${err?.message || err})`);
          return null;
        })
        .finally(() => _celestrakInflight.delete(group)));
    }
    const fresh = await _celestrakInflight.get(group);
    if (fresh) {
      send(200, fresh.body, 'MISS');
    } else if (entry) {
      send(200, entry.body, 'STALE-ERROR');
    } else {
      send(502, 'celestrak fetch failed and no cache available', 'NONE');
    }
  } catch (err) {
    send(500, `celestrak proxy error: ${err?.message || err}`, 'ERROR');
  }
}

/**
 * Folded in from api/launches.js (__r=launches).
 * Upstream: Launch Library 2 (ll.thespacedevs.com). In-memory cache TTL 15 min.
 */
const LAUNCHES_TTL_MS = 15 * 60_000;
let _launchesCache = null; // { at, body }
let _launchesInflight = null;

function launchesRequestHeaders() {
  const token = String(process.env.LL2_API_TOKEN || '').trim();
  return { Accept: 'application/json', ...(token ? { Authorization: `Token ${token}` } : {}) };
}

async function refreshLaunchesUpstream() {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86400000);
  const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
  url.searchParams.set('net__gte', start.toISOString());
  url.searchParams.set('net__lte', end.toISOString());
  url.searchParams.set('limit', '100');
  url.searchParams.set('mode', 'detailed');
  const upstream = await fetch(url, { signal: AbortSignal.timeout(20000), headers: launchesRequestHeaders() });
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
  _launchesCache = fresh;
  return fresh;
}

function sendLaunches(res, status, body, cacheState) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', status === 200 ? 'public, max-age=900' : 'no-store');
  res.setHeader('X-GEV-Cache', cacheState);
  res.send(body);
}

async function handleLaunches(req, res) {
  if (req.method !== 'GET') {
    sendLaunches(res, 405, JSON.stringify({ error: 'Method Not Allowed' }), 'NONE');
    return;
  }
  const now = Date.now();
  if (_launchesCache && now - _launchesCache.at < LAUNCHES_TTL_MS) {
    sendLaunches(res, 200, _launchesCache.body, 'HIT');
    return;
  }
  const stale = _launchesCache;
  if (!_launchesInflight) {
    _launchesInflight = refreshLaunchesUpstream().finally(() => { _launchesInflight = null; });
  }
  try {
    const fresh = await _launchesInflight;
    sendLaunches(res, 200, fresh.body, 'MISS');
  } catch (error) {
    if (stale) {
      console.warn(`[launch-library-proxy] refresh failed (${error?.message || error}) — serving stale cache`);
      sendLaunches(res, 200, stale.body, 'STALE-ERROR');
      return;
    }
    sendLaunches(
      res,
      Number.isInteger(error?.upstreamStatus) ? error.upstreamStatus : 502,
      error?.upstreamBody || JSON.stringify({ error: 'Launch Library 2 unavailable' }),
      'NONE',
    );
  }
}

export default async function handler(req, res) {
  try {
    const route = req.query?.__r;
    if (route === 'celestrak') return handleCelestrak(req, res);
    if (route === 'launches') return handleLaunches(req, res);
    res.status(404).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'unknown_route' }));
  } catch (err) {
    console.error('[space hub]', err?.message || err);
    if (!res.headersSent) {
      res.status(500).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'internal_error', message: String(err?.message || err) }));
    }
  }
}
