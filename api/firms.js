/**
 * Vercel port of vite.config.js's firmsProxy() (/api/firms). Reuses
 * parseFirmsCsv/filterTrailing24h from src/data/firmsCsv.js (already
 * imported by vite.config.js for the same route). In-memory cache TTL 30 min.
 */
import { parseFirmsCsv, filterTrailing24h } from '../src/data/firmsCsv.js';

const TTL_MS = 30 * 60_000;
const SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT'];

let mem = null; // { at, sources, fires }
let inflight = null;

function mapKey() {
  return String(process.env.FIRMS_MAP_KEY || '').trim();
}

async function fetchSource(key, source) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/world/2`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const records = parseFirmsCsv(await res.text());
  if (records === null) throw new Error('non-CSV upstream response');
  return records;
}

// Sequential (not parallel) fetches — quota courtesy, matching the original proxy.
async function refreshUpstream(key) {
  const now = Date.now();
  const sources = [];
  const fires = [];
  for (const source of SOURCES) {
    try {
      const records = filterTrailing24h(await fetchSource(key, source), now);
      sources.push({ source, count: records.length, ok: true });
      fires.push(...records);
    } catch (err) {
      console.warn(`[firms-proxy] ${source} fetch failed:`, err?.message || err);
      sources.push({ source, count: 0, ok: false });
    }
  }
  if (!sources.some((s) => s.ok)) throw new Error('all FIRMS sources failed');
  return { at: now, sources, fires };
}

function buildPayload(entry, stale) {
  const fires = filterTrailing24h(entry.fires, Date.now());
  return { fetchedAt: entry.at, stale, ttlMs: TTL_MS, sources: entry.sources, count: fires.length, fires };
}

export default async function handler(req, res) {
  const sendJson = (status, obj) => {
    res.status(status).setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(obj));
  };
  try {
    const key = mapKey();
    if (!key) { sendJson(503, { error: 'no_key' }); return; }

    const entry = mem;
    if (entry && Date.now() - entry.at < TTL_MS) {
      sendJson(200, buildPayload(entry, false));
      return;
    }
    if (!inflight) {
      inflight = refreshUpstream(key)
        .then((fresh) => { mem = fresh; return fresh; })
        .catch((err) => {
          console.warn(`[firms-proxy] refresh failed (${err?.message || err}) — serving cache if any`);
          return null;
        })
        .finally(() => { inflight = null; });
    }
    const fresh = await inflight;
    if (fresh) {
      sendJson(200, buildPayload(fresh, false));
    } else if (entry) {
      sendJson(200, buildPayload(entry, true));
    } else {
      sendJson(502, { error: 'firms fetch failed and no cache available' });
    }
  } catch (err) {
    console.warn('[firms-proxy] error:', err?.message || err);
    sendJson(500, { error: 'firms proxy error' });
  }
}
