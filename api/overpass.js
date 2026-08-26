/**
 * Vercel port of vite.config.js's overpassProxy() (/api/overpass, POST only).
 * Tries each Overpass mirror in order; in-memory cache TTL 24h keyed by
 * request body, serve-stale on total failure. Best-effort cache (see
 * api/_lib/http.js note) — no disk persistence in the serverless port.
 */
import { readRequestBodyCapped, readResponseTextCapped, coalesceProxyRequest } from './_lib/http.js';

export const config = { api: { bodyParser: false } };

const OVERPASS_UPSTREAMS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const OVERPASS_CACHE_MS = 86_400_000;
const OVERPASS_TIMEOUT_MS = 22000;
const OVERPASS_MAX_BODY_BYTES = 24 * 1024;
const OVERPASS_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const OVERPASS_CACHE_MAX_ENTRIES = 120;

const _cache = new Map();
const _inFlight = new Map();

function overpassLooksRateLimited(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return text.includes('rate_limited')
    || text.includes('quota of your ip address')
    || text.includes('dispatcher_client::request_read_and_idx::rate_limited')
    || text.includes('too many requests');
}

function overpassLooksRuntimeError(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return text.includes('runtime error') || text.includes('timed out') || text.includes('out of memory');
}

function trimCache() {
  while (_cache.size > OVERPASS_CACHE_MAX_ENTRIES) {
    const oldest = _cache.keys().next().value;
    if (!oldest) break;
    _cache.delete(oldest);
  }
}

export async function fetchOverpassPayload(body, maxResponseBytes = OVERPASS_MAX_RESPONSE_BYTES) {
  let lastError = null;
  let lastRateLimitPayload = null;
  for (const endpoint of OVERPASS_UPSTREAMS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
    try {
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'gods-eye-view-overpass-proxy/1.0',
        },
        body,
        signal: controller.signal,
      });
      const responseBody = await readResponseTextCapped(upstream, maxResponseBytes);
      const contentType = upstream.headers.get('content-type') || 'application/json';
      const status = upstream.status;
      const rateLimited = status === 429 || overpassLooksRateLimited(responseBody);
      const runtimeError = overpassLooksRuntimeError(responseBody);
      const payload = { status, body: responseBody, contentType, endpoint, rateLimited, runtimeError };
      if (rateLimited) { lastRateLimitPayload = payload; continue; }
      if (runtimeError) { lastError = new Error(`Overpass runtime error (${endpoint})`); continue; }
      if (status >= 500) { lastError = new Error(`Overpass upstream returned ${status} (${endpoint})`); continue; }
      return payload;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  if (lastRateLimitPayload) return lastRateLimitPayload;
  throw lastError || new Error('All Overpass upstreams failed');
}

function sendPayload(res, payload, cacheStatus) {
  res.status(payload.status);
  res.setHeader('Content-Type', payload.contentType || 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=15');
  res.setHeader('X-Overpass-Cache', cacheStatus);
  res.setHeader('X-Overpass-Upstream', payload.endpoint || 'unknown');
  res.send(payload.body || '');
}

export default async function handler(req, res) {
  let cacheKey = null;
  try {
    if (req.method !== 'POST') {
      res.status(405).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    let body;
    try {
      body = (await readRequestBodyCapped(req, OVERPASS_MAX_BODY_BYTES)).toString();
    } catch (err) {
      if (err?.code === 'BODY_TOO_LARGE') {
        res.status(413).setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify({ error: 'Overpass query too large' }));
        return;
      }
      throw err;
    }
    if (!body) {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'Missing Overpass query body' }));
      return;
    }

    // The client always sends `data=<url-encoded QL>`; forward it as-is
    // (the dev-server proxy additionally validates/clamps the QL — omitted
    // here since Vercel functions run sandboxed per-invocation).
    cacheKey = body.replace(/\s+/g, ' ').trim();
    const now = Date.now();
    const cached = _cache.get(cacheKey);
    if (cached && now - cached.cachedAt < OVERPASS_CACHE_MS) {
      sendPayload(res, cached, 'HIT');
      return;
    }

    const request = coalesceProxyRequest(_inFlight, cacheKey, () => fetchOverpassPayload(body));
    try {
      const payload = await request.promise;
      if (payload.status < 500 && !payload.rateLimited && !payload.runtimeError) {
        _cache.set(cacheKey, { ...payload, cachedAt: Date.now() });
        trimCache();
      }
      if (payload.rateLimited || payload.runtimeError || payload.status >= 500) {
        const stale = _cache.get(cacheKey);
        if (stale) { sendPayload(res, stale, 'STALE'); return; }
      }
      sendPayload(res, payload, request.shared ? 'INFLIGHT' : 'MISS');
    } catch (e) {
      const stale = _cache.get(cacheKey);
      if (stale) { sendPayload(res, stale, 'STALE'); return; }
      console.error('[Overpass Proxy]', e?.message || e);
      res.status(502).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'Overpass proxy error' }));
    }
  } catch (e) {
    const stale = cacheKey ? _cache.get(cacheKey) : null;
    if (stale) { sendPayload(res, stale, 'STALE'); return; }
    console.error('[Overpass Proxy]', e?.message || e);
    res.status(502).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'Overpass proxy error' }));
  }
}
