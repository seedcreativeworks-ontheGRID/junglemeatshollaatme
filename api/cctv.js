/**
 * Consolidated hub for CCTV routes (Vercel Hobby plan's 12 Serverless
 * Function cap forces route consolidation — see vercel.json rewrites).
 * Dispatches on `req.query.__r`.
 *
 * Routes folded in (original file → __r key):
 *   api/cctv/sources.js      → sources
 *   api/cctv/health.js       → health
 *   api/cctv/frame/[id].js   → frame  (streams image/svg — content-type/binary preserved)
 *   api/cctv/media/[id].js   → media  (Range-header video/HLS passthrough preserved)
 */
import { getCctvSources, normalizeFeedType, isVideoFeedType, fetchCctvImageFromUpstream, buildSyntheticCctvSvg, proxyMediaResponse } from './_lib/cctvCatalog.js';

/** Folded in from api/cctv/sources.js (__r=sources). */
async function handleCctvSources(req, res) {
  try {
    const sources = await getCctvSources();
    const body = {
      sources: sources.map((source) => ({
        id: source.id,
        name: source.name,
        city: source.city,
        cityId: source.cityId,
        provider: source.provider,
        lat: source.lat,
        lon: source.lon,
        headingDeg: source.headingDeg,
        headingConfidence: source.headingConfidence || '',
        pitchDeg: source.pitchDeg,
        fovDeg: source.fovDeg,
        rangeM: source.rangeM,
        mountHeightM: source.mountHeightM,
        groundElevationM: source.groundElevationM,
        feedType: normalizeFeedType(source.feedType),
        sourceKind: source.sourceKind || (source.url ? 'configured' : 'fallback'),
        poseSource: source.poseSource,
        license: source.license,
      })),
    };
    res.status(200).setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(body));
  } catch (error) {
    console.error('[CCTV sources]', error?.message || error);
    res.status(500).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'CCTV proxy error' }));
  }
}

/**
 * Folded in from api/cctv/health.js (__r=health). NOTE: the original proxy
 * tracks per-camera health in an in-memory map updated by the frame/media
 * routes. On Vercel each API route was its own isolated serverless function
 * (no shared memory across files/instances), so that map couldn't be
 * meaningfully populated — this endpoint returns an empty (but
 * correctly-shaped) report rather than fabricating state, same as before
 * consolidation.
 */
async function handleCctvHealth(req, res) {
  res.status(200).setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify({ cameras: [] }));
}

/** Folded in from api/cctv/frame/[id].js (__r=frame, ?id=...). */
async function streetViewFallback({ lat, lon, heading, fov, pitch }) {
  const streetViewKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!streetViewKey || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  try {
    const sv = new URL('https://maps.googleapis.com/maps/api/streetview');
    sv.searchParams.set('size', '960x540');
    sv.searchParams.set('location', `${lat},${lon}`);
    sv.searchParams.set('heading', String(Number.isFinite(heading) ? heading : 0));
    sv.searchParams.set('fov', String(Number.isFinite(fov) ? Math.max(20, Math.min(120, fov)) : 80));
    sv.searchParams.set('pitch', String(Number.isFinite(pitch) ? Math.max(-40, Math.min(20, pitch)) : 0));
    sv.searchParams.set('source', 'outdoor');
    sv.searchParams.set('return_error_code', 'true');
    sv.searchParams.set('key', streetViewKey);
    const svResp = await fetch(sv.toString(), {
      headers: { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    const svType = svResp.headers.get('content-type') || '';
    if (!svResp.ok || !svType.startsWith('image/')) return null;
    return { ok: true, body: Buffer.from(await svResp.arrayBuffer()), contentType: svType };
  } catch {
    return null;
  }
}

async function handleCctvFrame(req, res) {
  try {
    const sources = await getCctvSources();
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const cameraId = decodeURIComponent(String(req.query?.id || '').trim()) || 'camera';
    const source = sourceById.get(cameraId);
    const query = req.query || {};
    const label = query.label || source?.name || cameraId;
    const city = query.city || source?.city || '';
    const lat = Number(query.lat || source?.lat);
    const lon = Number(query.lon || source?.lon);
    const heading = Number(query.heading || source?.headingDeg);
    const fov = Number(query.fov || source?.fovDeg);
    const pitch = Number(query.pitch || source?.pitchDeg);

    // Only server-registered upstream URLs — never a client-supplied URL (SSRF guard).
    const upstreamCandidate = source?.snapshotUrl
      || (!isVideoFeedType(normalizeFeedType(source?.feedType)) ? source?.url : '');

    const upstreamImage = await fetchCctvImageFromUpstream(upstreamCandidate);
    if (upstreamImage?.ok) {
      res.status(200);
      res.setHeader('Content-Type', upstreamImage.contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-CCTV-Source', 'upstream-image');
      res.send(upstreamImage.body);
      return;
    }

    const sv = await streetViewFallback({ lat, lon, heading, fov, pitch });
    if (sv?.ok) {
      res.status(200);
      res.setHeader('Content-Type', sv.contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-CCTV-Source', 'streetview');
      res.send(sv.body);
      return;
    }

    const svg = buildSyntheticCctvSvg({
      cameraId,
      label,
      city,
      status: source?.url ? 'UPSTREAM UNAVAILABLE' : 'NO UPSTREAM CONFIGURED',
    });
    res.status(200);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-CCTV-Source', 'synthetic');
    res.send(svg);
  } catch (error) {
    console.error('[CCTV Frame Proxy]', error?.message || String(error));
    res.status(500).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'CCTV proxy error' }));
  }
}

/**
 * Folded in from api/cctv/media/[id].js (__r=media, ?id=...). Supports Range
 * headers for video/HLS passthrough — streamed via proxyMediaResponse
 * exactly as before, no buffering.
 */
async function handleCctvMedia(req, res) {
  try {
    const sources = await getCctvSources();
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const cameraId = decodeURIComponent(String(req.query?.id || '').trim()) || 'camera';
    const source = sourceById.get(cameraId);
    const mediaUrl = source?.url || '';

    if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
      res.status(404).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'No media URL configured for this camera' }));
      return;
    }

    try {
      const upstreamHeaders = { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' };
      const requestRange = req.headers?.range;
      if (requestRange) upstreamHeaders.Range = requestRange;
      const upstream = await fetch(mediaUrl, { headers: upstreamHeaders, signal: AbortSignal.timeout(15000) });
      if (!upstream.ok) {
        res.status(upstream.status).setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.send(JSON.stringify({ error: `Upstream returned ${upstream.status}` }));
        return;
      }
      await proxyMediaResponse(res, upstream, { sourceHeader: 'upstream' });
    } catch (error) {
      res.status(502).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify({ error: 'Media proxy failed' }));
    }
  } catch (error) {
    console.error('[CCTV Media Proxy]', error?.message || String(error));
    res.status(500).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'CCTV proxy error' }));
  }
}

export default async function handler(req, res) {
  try {
    const route = req.query?.__r;
    if (route === 'sources') return handleCctvSources(req, res);
    if (route === 'health') return handleCctvHealth(req, res);
    if (route === 'frame') return handleCctvFrame(req, res);
    if (route === 'media') return handleCctvMedia(req, res);
    res.status(404).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'unknown_route' }));
  } catch (err) {
    console.error('[cctv hub]', err?.message || err);
    if (!res.headersSent) {
      res.status(500).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'internal_error', message: String(err?.message || err) }));
    }
  }
}
