/**
 * Vercel port of vite.config.js's tomtomProxy() flow-tile route
 * (/api/tomtom/flow/:z/:x/:y.pbf). Upstream:
 * https://api.tomtom.com/traffic/map/4/tile/flow/relative/{z}/{x}/{y}.pbf
 *
 * Budget governor NOTE: the daily-tile-budget counter here is a plain
 * module-scope variable — best-effort only. It resets on cold start and is
 * NOT shared across concurrent serverless instances (each instance has its
 * own counter), unlike the original dev-server's disk-backed counter. A real
 * shared budget would need Vercel KV / Upstash Redis; intentionally not
 * implemented here (see docs/DEPLOYMENT.md).
 */
import { isValidTileCoord, utcDayKey, normalizeBudget, isOverBudget } from '../../../../../src/data/tomtomTiles.js';

const TILE_TTL_MS = 120_000;
const MEM_MAX_ENTRIES = 256;
const UPSTREAM_TIMEOUT_MS = 15000;
const DEFAULT_DAILY_BUDGET = 40000;

const mem = new Map();
const inflight = new Map();
let budget = null;

function dailyBudgetLimit() {
  const raw = Number.parseInt(process.env.TOMTOM_DAILY_TILE_BUDGET || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET;
}

function currentBudget() {
  budget = normalizeBudget(budget, utcDayKey());
  return budget;
}

function memSet(key, entry) {
  if (!mem.has(key) && mem.size >= MEM_MAX_ENTRIES) {
    const oldest = mem.keys().next().value;
    mem.delete(oldest);
  }
  mem.set(key, entry);
}

async function fetchUpstream(z, x, y) {
  const url = 'https://api.tomtom.com/traffic/map/4/tile/flow/relative/'
    + `${z}/${x}/${y}.pbf?key=${encodeURIComponent(process.env.TOMTOM_API_KEY)}`;
  currentBudget().count += 1; // attempts count — upstream bills the request either way
  const res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('empty tile body');
  return buf;
}

export default async function handler(req, res) {
  const sendJson = (status, obj) => {
    res.status(status).setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(obj));
  };
  const sendTile = (buf, cacheStatus) => {
    res.status(200);
    res.setHeader('Content-Type', 'application/x-protobuf');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('x-tomtom-cache', cacheStatus);
    res.send(buf);
  };

  try {
    const z = Number(req.query?.z);
    const x = Number(req.query?.x);
    const yRaw = String(req.query?.y || '');
    const yMatch = yRaw.match(/^(\d+)\.pbf$/);
    if (!yMatch) { sendJson(404, { error: 'not_found' }); return; }
    const y = Number(yMatch[1]);

    if (!isValidTileCoord(z, x, y)) { sendJson(400, { error: 'invalid_tile' }); return; }
    if (!process.env.TOMTOM_API_KEY) { sendJson(503, { error: 'no_key' }); return; }

    const key = `${z}/${x}/${y}`;
    const now = Date.now();
    let entry = mem.get(key);
    if (entry && now - entry.at < TILE_TTL_MS) { sendTile(entry.buf, 'HIT'); return; }

    if (isOverBudget(currentBudget(), dailyBudgetLimit())) {
      if (entry) { sendTile(entry.buf, 'STALE-BUDGET'); return; }
      sendJson(429, { error: 'budget' });
      return;
    }

    if (!inflight.has(key)) {
      inflight.set(key, fetchUpstream(z, x, y)
        .then((buf) => {
          const fresh = { at: Date.now(), buf };
          memSet(key, fresh);
          return fresh;
        })
        .catch((err) => {
          console.warn(`[tomtom-proxy] tile ${key} refresh failed: ${err?.message || err}`);
          return null;
        })
        .finally(() => inflight.delete(key)));
    }
    const fresh = await inflight.get(key);
    if (fresh) {
      sendTile(fresh.buf, 'MISS');
    } else if (entry) {
      sendTile(entry.buf, 'STALE-ERROR');
    } else {
      sendJson(502, { error: 'tile fetch failed' });
    }
  } catch (err) {
    console.error('[tomtom-proxy]', err?.message || err);
    sendJson(500, { error: 'tomtom proxy error' });
  }
}
