/**
 * Vercel port of vite.config.js's trackBackfillProxies() /api/adsblol/trace
 * route (?hex=...). In-memory cache TTL 60s.
 */
import { readResponseTextCapped } from '../_lib/http.js';

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

export default async function handler(req, res) {
  try {
    const incoming = new URL(req.url || '', 'http://localhost');
    const hex = String(incoming.searchParams.get('hex') || '').trim().toLowerCase();
    if (!/^[0-9a-f~]{6,7}$/.test(hex)) {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'hex must be a 6-7 char hex string' }));
      return;
    }
    const key = `lol:${hex}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < TRACK_CACHE_MS) {
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
      const text = await readResponseTextCapped(upstream, RESPONSE_CAP_BYTES);
      body = upstream.ok ? text : JSON.stringify({ error: `Track source HTTP ${upstream.status}` });
    } catch {
      body = JSON.stringify({ error: 'Upstream track response too large' });
    }
    cachePut(key, { at: Date.now(), status: upstream.status, body });
    res.status(upstream.status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  } catch (error) {
    res.status(502).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'adsb.lol trace fetch failed' }));
  }
}
