/**
 * Vercel port of vite.config.js's aisStreamProxy() (/api/ais-live).
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
export default async function handler(req, res) {
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
