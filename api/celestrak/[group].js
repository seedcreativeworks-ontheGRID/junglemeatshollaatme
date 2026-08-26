/**
 * Vercel port of vite.config.js's celestrakProxy() (/api/celestrak/:group).
 * Upstream: https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=tle
 * In-memory cache (best-effort, see api/_lib/http.js), TTL 6h, serve-stale on failure.
 */

const TLE_TTL_MS = 6 * 3600_000;
const mem = new Map(); // group -> { at, body }
const inflight = new Map();

async function fetchUpstream(group) {
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

export default async function handler(req, res) {
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
    const entry = mem.get(group);
    if (entry && now - entry.at < TLE_TTL_MS) {
      send(200, entry.body, 'HIT');
      return;
    }
    if (!inflight.has(group)) {
      inflight.set(group, fetchUpstream(group)
        .then((fresh) => { mem.set(group, fresh); return fresh; })
        .catch((err) => {
          console.warn(`[celestrak-proxy] ${group} refresh failed (${err?.message || err})`);
          return null;
        })
        .finally(() => inflight.delete(group)));
    }
    const fresh = await inflight.get(group);
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
