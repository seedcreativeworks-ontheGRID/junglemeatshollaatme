import { getCctvSources, proxyMediaResponse } from '../../_lib/cctvCatalog.js';

export default async function handler(req, res) {
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
      const upstream = await fetch(mediaUrl, { headers: upstreamHeaders });
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
