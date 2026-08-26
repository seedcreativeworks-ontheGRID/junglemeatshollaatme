/**
 * Vercel port of vite.config.js's adsbdbProxy() /api/adsbdb/type/:hex route.
 * In-memory cache TTL 24h, negative-cache 404s.
 */
const TTL_MS = 24 * 3600_000;
const cache = new Map(); // hex -> { at, data }
const inflight = new Map();

const fresh = (e) => e && Date.now() - e.at < TTL_MS;

function parseAircraft(json) {
  const a = json?.response?.aircraft;
  if (!a) return null;
  return {
    typeCode: a.icao_type || null,
    typeName: a.manufacturer && a.type ? `${a.manufacturer} ${a.type}` : (a.type || null),
    registration: a.registration || null,
  };
}

function lookup(hex) {
  if (fresh(cache.get(hex))) return Promise.resolve(cache.get(hex).data);
  if (!inflight.has(hex)) {
    inflight.set(hex, (async () => {
      try {
        const res = await fetch(`https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(hex)}`, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = parseAircraft(await res.json());
          cache.set(hex, { at: Date.now(), data });
          return data;
        }
        if (res.status === 404) {
          cache.set(hex, { at: Date.now(), data: null });
        }
        const entry = cache.get(hex);
        return fresh(entry) ? entry.data : null;
      } catch {
        const entry = cache.get(hex);
        return fresh(entry) ? entry.data : null;
      } finally {
        inflight.delete(hex);
      }
    })());
  }
  return inflight.get(hex);
}

export default async function handler(req, res) {
  const send = (status, obj) => {
    res.status(status).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(obj));
  };
  try {
    const hex = String(req.query?.hex || '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) return send(400, { error: 'invalid hex' });
    const data = await lookup(hex);
    return send(200, data ? { found: true, ...data } : { found: false });
  } catch (err) {
    return send(500, { error: String(err?.message || err) });
  }
}
