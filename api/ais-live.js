/**
 * Vercel port of vite.config.js's aisStreamProxy() (/api/ais-live). Native
 * route (highest-traffic AIS endpoint) — no `__r` dispatch needed for it,
 * same as api/opensky.js. `/api/ais-live/track` was folded in below
 * (__r=track) as part of the Hobby-plan function-count consolidation — see
 * vercel.json rewrites.
 *
 * The real implementation holds a persistent outbound WebSocket to
 * wss://stream.aisstream.io/v0/stream inside the long-running dev-server
 * process. That fundamentally cannot work in a stateless serverless
 * function — there is no persistent connection across invocations. This
 * endpoint instead reports the feed as honestly unavailable, in the same
 * response shape the real proxy uses, so the client's existing "unavailable"
 * UI state (see src/data/aisLiveVessels.js's deriveAisFeedError) degrades
 * gracefully instead of throwing. For real AIS live tracking, run
 * `npm run dev` locally or stand up an always-on relay — see
 * docs/DEPLOYMENT.md.
 */
async function handleAisLiveDefault(req, res) {
  res.status(200);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify({
    rows: [],
    source: 'unavailable',
    status: 'unavailable',
    error: 'AIS live tracking requires a persistent WebSocket connection, which is not available in this serverless deployment. Run locally with `npm run dev` for live AIS, or see docs/DEPLOYMENT.md for how to add an always-on relay.',
    refreshing: false,
  }));
}

/**
 * Folded in from api/ais-live/track.js (__r=track). Same "requires a
 * persistent WebSocket" limitation as the default route above.
 */
async function handleAisLiveTrack(req, res) {
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

export default async function handler(req, res) {
  try {
    const route = req.query?.__r;
    if (!route) return handleAisLiveDefault(req, res);
    if (route === 'track') return handleAisLiveTrack(req, res);
    res.status(404).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'unknown_route' }));
  } catch (err) {
    console.error('[ais-live hub]', err?.message || err);
    if (!res.headersSent) {
      res.status(500).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'internal_error', message: String(err?.message || err) }));
    }
  }
}
