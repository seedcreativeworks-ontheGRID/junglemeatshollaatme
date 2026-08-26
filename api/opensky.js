/**
 * Vercel port of vite.config.js's openSkyProxy() (/api/opensky). Multi-mode
 * auth (oauth|basic|auto|anon), ~9s in-memory response cache (best-effort,
 * see api/_lib/http.js), and an adsb.lol point fallback on total failure.
 */
import { getOpenSkyToken } from './_lib/openskyAuth.js';
import { readResponseJsonCapped } from './_lib/http.js';
import { normalizeAdsbLolPointResponse } from '../src/data/adsbLolFallback.js';

const OPENSKY_CACHE_MS = 9000;
const ADSBLOL_POINT_RADIUS_NM = 250;
const OPENSKY_AUTH_MODE_SET = new Set(['oauth', 'basic', 'auto', 'anon']);

let _cacheBody = null;
let _cacheStatus = 0;
let _cacheTime = 0;
let _cacheMeta = null;

function normalizeAuthMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  return OPENSKY_AUTH_MODE_SET.has(raw) ? raw : 'oauth';
}

function buildHeaders({ cacheStatus, requestedMode, usedMode, reason }) {
  return {
    'Cache-Control': 'no-store',
    'X-OpenSky-Cache': cacheStatus,
    'X-OpenSky-Auth': usedMode,
    'X-OpenSky-Auth-Mode-Requested': requestedMode,
    'X-OpenSky-Auth-Mode-Used': usedMode,
    'X-OpenSky-Auth-Reason': reason,
  };
}

async function fetchAdsbLolFallback(query) {
  const lat = Number(query.lat);
  const lon = Number(query.lon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  const roundedLat = Math.round(lat * 4) / 4;
  const roundedLon = Math.round(lon * 4) / 4;
  try {
    const upstream = await fetch(
      `https://api.adsb.lol/v2/lat/${roundedLat}/lon/${roundedLon}/dist/${ADSBLOL_POINT_RADIUS_NM}`,
      {
        headers: { Accept: 'application/json', 'User-Agent': 'gods-eye-view-adsblol-regional-fallback/1.0' },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!upstream.ok) return null;
    const payload = await readResponseJsonCapped(upstream, 8 * 1024 * 1024);
    const normalized = normalizeAdsbLolPointResponse(payload);
    return { body: JSON.stringify(normalized), count: normalized.states.length };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    const requestedMode = normalizeAuthMode(process.env.OPENSKY_AUTH_MODE);
    const now = Date.now();

    if (_cacheBody && now - _cacheTime < OPENSKY_CACHE_MS) {
      const meta = _cacheMeta || { requestedMode, usedMode: 'unknown', reason: 'cached' };
      res.status(_cacheStatus || 200);
      for (const [k, v] of Object.entries(buildHeaders({ cacheStatus: 'HIT', requestedMode: meta.requestedMode || requestedMode, usedMode: meta.usedMode, reason: meta.reason }))) {
        res.setHeader(k, v);
      }
      res.setHeader('Content-Type', 'application/json');
      res.send(_cacheBody);
      return;
    }

    const basicUser = process.env.OPENSKY_USERNAME || '';
    const basicPass = process.env.OPENSKY_PASSWORD || '';
    const hasBasicCreds = Boolean(basicUser && basicPass);
    const headers = { Accept: 'application/json' };
    let usedMode = 'anon';
    let reason = 'forced_anonymous';

    if (requestedMode === 'basic') {
      if (hasBasicCreds) {
        headers.Authorization = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`;
        usedMode = 'basic';
        reason = 'basic_credentials';
      } else {
        reason = 'missing_basic_creds';
      }
    } else if (requestedMode === 'oauth') {
      const token = await getOpenSkyToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
        usedMode = 'oauth';
        reason = 'oauth_token';
      } else {
        reason = 'oauth_invalid_or_missing';
      }
    } else if (requestedMode === 'auto') {
      const token = await getOpenSkyToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
        usedMode = 'oauth';
        reason = 'oauth_token';
      } else if (hasBasicCreds) {
        headers.Authorization = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`;
        usedMode = 'basic';
        reason = 'oauth_unavailable_fallback_basic';
      } else {
        reason = 'missing_oauth_and_basic_creds';
      }
    }

    let upstream = await fetch('https://opensky-network.org/api/states/all?extended=1', { headers });
    if ((upstream.status === 401 || upstream.status === 403) && requestedMode === 'auto' && usedMode === 'oauth' && hasBasicCreds) {
      upstream = await fetch('https://opensky-network.org/api/states/all?extended=1', {
        headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}` },
      });
      usedMode = 'basic';
      reason = 'oauth_rejected_fallback_basic';
    }

    if (!upstream.ok) {
      const fallback = await fetchAdsbLolFallback(req.query || {});
      if (fallback) {
        res.status(200);
        for (const [k, v] of Object.entries(buildHeaders({ cacheStatus: 'MISS', requestedMode, usedMode: 'adsblol-regional', reason: `opensky_http_${upstream.status}_regional_fallback` }))) {
          res.setHeader(k, v);
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Flight-Source', 'adsb.lol');
        res.setHeader('X-Flight-Count', String(fallback.count));
        res.send(fallback.body);
        return;
      }
      if (_cacheBody) {
        res.status(200);
        for (const [k, v] of Object.entries(buildHeaders({ cacheStatus: 'STALE', requestedMode, usedMode, reason: 'upstream_failed_serving_stale' }))) {
          res.setHeader(k, v);
        }
        res.setHeader('Content-Type', 'application/json');
        res.send(_cacheBody);
        return;
      }
      let errorBody = { error: `OpenSky upstream returned HTTP ${upstream.status}` };
      if (upstream.status === 401 || upstream.status === 403) {
        errorBody = { error: 'OpenSky auth invalid or missing for the configured auth mode.' };
      }
      res.status(upstream.status || 502);
      for (const [k, v] of Object.entries(buildHeaders({ cacheStatus: 'NONE', requestedMode, usedMode, reason }))) res.setHeader(k, v);
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(errorBody));
      return;
    }

    const body = await upstream.text();
    _cacheBody = body;
    _cacheStatus = upstream.status;
    _cacheTime = now;
    _cacheMeta = { requestedMode, usedMode, reason };

    res.status(200);
    for (const [k, v] of Object.entries(buildHeaders({ cacheStatus: 'MISS', requestedMode, usedMode, reason }))) res.setHeader(k, v);
    res.setHeader('Content-Type', 'application/json');
    res.send(body);
  } catch (err) {
    console.error('[opensky proxy]', err?.message || err);
    if (_cacheBody) {
      res.status(200);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-OpenSky-Cache', 'STALE');
      res.send(_cacheBody);
      return;
    }
    res.status(502);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'OpenSky proxy error' }));
  }
}
