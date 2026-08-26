/**
 * Vercel port of vite.config.js's gbfsProxy() (/api/gbfs/*). Path segment 0
 * (URL-encoded) is the upstream GBFS URL. SSRF guard: HTTPS only, host
 * allowlist, path must end in station_information.json or station_status.json.
 */

const GBFS_PROXY_TIMEOUT_MS = 12000;
const GBFS_MAX_BODY_BYTES = 5 * 1024 * 1024;
const GBFS_ALLOWED_HOSTS = new Set([
  'gbfs.lyft.com',
  'gbfs.bluebikes.com',
  'gbfs.bcycle.com',
  'gbfs.biketownpdx.com',
  'gbfs.cogobikeshare.com',
]);

function isAllowedGbfsHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return false;
  if (GBFS_ALLOWED_HOSTS.has(host)) return true;
  return host.endsWith('.publicbikesystem.net');
}

function isAllowedGbfsPath(pathname) {
  return /\/station_(information|status)\.json$/i.test(String(pathname || ''));
}

function gbfsCacheControl(pathname) {
  if (/\/station_information\.json$/i.test(String(pathname || ''))) return 'public, max-age=300';
  return 'no-store';
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.status(405).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    const segments = Array.isArray(req.query?.path) ? req.query.path : [req.query?.path].filter(Boolean);
    const encodedTarget = segments.join('/');
    if (!encodedTarget) {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'Missing GBFS upstream target' }));
      return;
    }

    let decodedTarget = '';
    try { decodedTarget = decodeURIComponent(encodedTarget); } catch {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'Invalid GBFS target encoding' }));
      return;
    }

    let upstreamUrl;
    try { upstreamUrl = new URL(decodedTarget); } catch {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'Invalid GBFS upstream URL' }));
      return;
    }

    if (upstreamUrl.protocol !== 'https:') {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'Only https GBFS targets are allowed' }));
      return;
    }
    if (!isAllowedGbfsHost(upstreamUrl.hostname)) {
      res.status(403).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'GBFS host not allowed' }));
      return;
    }
    if (!isAllowedGbfsPath(upstreamUrl.pathname)) {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'Only station_information/station_status endpoints are allowed' }));
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GBFS_PROXY_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(upstreamUrl.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'gods-eye-view-gbfs-proxy/1.0' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const contentLength = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > GBFS_MAX_BODY_BYTES) {
      res.status(502).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'GBFS upstream response too large' }));
      return;
    }
    const body = await upstream.text();
    if (body.length > GBFS_MAX_BODY_BYTES) {
      res.status(502).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'GBFS upstream response too large' }));
      return;
    }
    const contentType = upstream.headers.get('content-type') || 'application/json';
    res.status(upstream.status);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', gbfsCacheControl(upstreamUrl.pathname));
    res.setHeader('X-GBFS-Upstream', upstreamUrl.hostname);
    res.send(body);
  } catch (error) {
    if (error?.name === 'AbortError') {
      res.status(504).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'GBFS upstream timeout' }));
      return;
    }
    console.error('[GBFS Proxy]', error?.message || String(error));
    res.status(502).setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify({ error: 'GBFS proxy error' }));
  }
}
