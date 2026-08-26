import { getCctvSources, isVideoFeedType, normalizeFeedType, fetchCctvImageFromUpstream, buildSyntheticCctvSvg } from '../../_lib/cctvCatalog.js';

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

export default async function handler(req, res) {
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
