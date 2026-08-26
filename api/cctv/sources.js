import { getCctvSources, normalizeFeedType } from '../_lib/cctvCatalog.js';

export default async function handler(req, res) {
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
