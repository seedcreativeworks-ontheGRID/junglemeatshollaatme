/** Vercel port of vite.config.js's adsbLolProxy() (/api/adsblol/mil). */
const CACHE_MS = 12000;
let _cache = null;
let _cacheAt = 0;

export default async function handler(req, res) {
  try {
    const now = Date.now();
    if (_cache && now - _cacheAt < CACHE_MS) {
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-ADS-B-Cache', 'HIT');
      res.send(_cache);
      return;
    }
    const upstream = await fetch('https://api.adsb.lol/v2/mil', {
      headers: { 'User-Agent': 'gods-eye-view-adsblol-proxy/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    const body = await upstream.text();
    if (upstream.ok) {
      _cache = body;
      _cacheAt = now;
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-ADS-B-Cache', 'MISS');
      res.send(body);
      return;
    }
    if (_cache) {
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-ADS-B-Cache', 'STALE-ERROR');
      res.send(_cache);
      return;
    }
    res.status(upstream.status).setHeader('Content-Type', 'application/json');
    res.send(body);
  } catch (err) {
    if (_cache) {
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-ADS-B-Cache', 'STALE-ERROR');
      res.send(_cache);
      return;
    }
    console.error('[adsblol mil proxy]', err?.message || err);
    res.status(502).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'adsb.lol proxy error' }));
  }
}
