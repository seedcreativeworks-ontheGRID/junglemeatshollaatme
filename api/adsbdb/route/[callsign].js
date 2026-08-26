/**
 * Vercel port of vite.config.js's adsbdbProxy() /api/adsbdb/route/:callsign
 * route. In-memory cache TTL 24h, negative-cache 404s (best-effort, see
 * api/_lib/http.js note).
 */
const TTL_MS = 24 * 3600_000;
const cache = new Map(); // callsign -> { at, data }
const inflight = new Map();

const fresh = (e) => e && Date.now() - e.at < TTL_MS;

function parseRoute(json) {
  const fr = json?.response?.flightroute;
  if (!fr?.origin || !fr?.destination) return null;
  const airport = (a) => ({
    code: a.iata_code || a.icao_code || '',
    name: a.municipality || a.name || '',
    lat: Number.isFinite(a.latitude) ? a.latitude : null,
    lon: Number.isFinite(a.longitude) ? a.longitude : null,
  });
  return { airline: fr.airline?.name || null, origin: airport(fr.origin), destination: airport(fr.destination) };
}

function lookup(cs) {
  if (fresh(cache.get(cs))) return Promise.resolve(cache.get(cs).data);
  if (!inflight.has(cs)) {
    inflight.set(cs, (async () => {
      try {
        const res = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = parseRoute(await res.json());
          cache.set(cs, { at: Date.now(), data });
          return data;
        }
        if (res.status === 404) {
          cache.set(cs, { at: Date.now(), data: null });
        }
        const entry = cache.get(cs);
        return fresh(entry) ? entry.data : null;
      } catch {
        const entry = cache.get(cs);
        return fresh(entry) ? entry.data : null;
      } finally {
        inflight.delete(cs);
      }
    })());
  }
  return inflight.get(cs);
}

export default async function handler(req, res) {
  const send = (status, obj) => {
    res.status(status).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(obj));
  };
  try {
    const cs = String(req.query?.callsign || '').toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(cs)) return send(400, { error: 'invalid callsign' });
    const data = await lookup(cs);
    return send(200, data ? { found: true, ...data } : { found: false });
  } catch (err) {
    return send(500, { error: String(err?.message || err) });
  }
}
