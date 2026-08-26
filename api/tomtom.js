/**
 * Consolidated hub for TomTom traffic routes (Vercel Hobby plan's 12
 * Serverless Function cap forces route consolidation — see vercel.json
 * rewrites). Dispatches on `req.query.__r`.
 *
 * Routes folded in (original file → __r key):
 *   api/tomtom/status.js            → status
 *   api/tomtom/flow/[z]/[x]/[y].js  → flow (raw application/x-protobuf bytes — no JSON wrapping)
 *
 * The two budget-governor counters below are kept as separate module-scope
 * variables (not shared) to match the original two-separate-functions
 * behavior, where api/tomtom/status.js and api/tomtom/flow/... each had
 * their own isolated, best-effort, cold-start-reset counter (see the
 * budget-governor note in the original flow handler).
 */
import { utcDayKey, normalizeBudget, isValidTileCoord, isOverBudget } from '../src/data/tomtomTiles.js';

const DEFAULT_DAILY_BUDGET = 40000;

function dailyBudgetLimit() {
  const raw = Number.parseInt(process.env.TOMTOM_DAILY_TILE_BUDGET || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET;
}

/** Folded in from api/tomtom/status.js (__r=status). */
let _statusBudget = null;

function currentStatusBudget() {
  _statusBudget = normalizeBudget(_statusBudget, utcDayKey());
  return _statusBudget;
}

async function handleTomtomStatus(req, res) {
  try {
    const hasKey = Boolean(process.env.TOMTOM_API_KEY);
    const b = currentStatusBudget();
    res.status(200).setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify({ hasKey, dailyCount: b.count, budget: dailyBudgetLimit(), date: b.date }));
  } catch (error) {
    console.error('[tomtom-status]', error?.message || error);
    if (!res.headersSent) {
      res.status(500).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'internal_error', message: String(error?.message || error) }));
    }
  }
}

/**
 * Folded in from api/tomtom/flow/[z]/[x]/[y].js (__r=flow). The vercel.json
 * rewrite captures :z/:x/:y into req.query — :y still carries the literal
 * ".pbf" suffix (e.g. "5.pbf"), stripped below exactly as the original did.
 * Upstream: https://api.tomtom.com/traffic/map/4/tile/flow/relative/{z}/{x}/{y}.pbf
 */
const TILE_TTL_MS = 120_000;
const MEM_MAX_ENTRIES = 256;
const UPSTREAM_TIMEOUT_MS = 15000;

const _flowMem = new Map();
const _flowInflight = new Map();
let _flowBudget = null;

function currentFlowBudget() {
  _flowBudget = normalizeBudget(_flowBudget, utcDayKey());
  return _flowBudget;
}

function flowMemSet(key, entry) {
  if (!_flowMem.has(key) && _flowMem.size >= MEM_MAX_ENTRIES) {
    const oldest = _flowMem.keys().next().value;
    _flowMem.delete(oldest);
  }
  _flowMem.set(key, entry);
}

async function fetchFlowUpstream(z, x, y) {
  const url = 'https://api.tomtom.com/traffic/map/4/tile/flow/relative/'
    + `${z}/${x}/${y}.pbf?key=${encodeURIComponent(process.env.TOMTOM_API_KEY)}`;
  currentFlowBudget().count += 1; // attempts count — upstream bills the request either way
  const res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('empty tile body');
  return buf;
}

async function handleTomtomFlow(req, res) {
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
    let entry = _flowMem.get(key);
    if (entry && now - entry.at < TILE_TTL_MS) { sendTile(entry.buf, 'HIT'); return; }

    if (isOverBudget(currentFlowBudget(), dailyBudgetLimit())) {
      if (entry) { sendTile(entry.buf, 'STALE-BUDGET'); return; }
      sendJson(429, { error: 'budget' });
      return;
    }

    if (!_flowInflight.has(key)) {
      _flowInflight.set(key, fetchFlowUpstream(z, x, y)
        .then((buf) => {
          const fresh = { at: Date.now(), buf };
          flowMemSet(key, fresh);
          return fresh;
        })
        .catch((err) => {
          console.warn(`[tomtom-proxy] tile ${key} refresh failed: ${err?.message || err}`);
          return null;
        })
        .finally(() => _flowInflight.delete(key)));
    }
    const fresh = await _flowInflight.get(key);
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

export default async function handler(req, res) {
  try {
    const route = req.query?.__r;
    if (route === 'status') return handleTomtomStatus(req, res);
    if (route === 'flow') return handleTomtomFlow(req, res);
    res.status(404).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'unknown_route' }));
  } catch (err) {
    console.error('[tomtom hub]', err?.message || err);
    if (!res.headersSent) {
      res.status(500).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'internal_error', message: String(err?.message || err) }));
    }
  }
}
