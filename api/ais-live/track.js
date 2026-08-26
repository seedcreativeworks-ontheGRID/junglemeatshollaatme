/**
 * Vercel port of vite.config.js's /api/ais-live/track sub-route. Same
 * "requires a persistent WebSocket" limitation as /api/ais-live — see that
 * file's comment and docs/DEPLOYMENT.md.
 */
export default async function handler(req, res) {
  const mmsi = String(req.query?.mmsi || '').trim();
  const ok = /^\d{5,10}$/.test(mmsi);
  res.status(ok ? 200 : 400);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (!ok) {
    res.send(JSON.stringify({ error: 'mmsi query param required', samples: [] }));
    return;
  }
  res.send(JSON.stringify({
    mmsi,
    samples: [],
    source: 'unavailable',
    error: 'AIS live tracking requires a persistent WebSocket connection, which is not available in this serverless deployment. Run locally with `npm run dev` for live AIS, or see docs/DEPLOYMENT.md for how to add an always-on relay.',
    retainedSec: 0,
  }));
}
