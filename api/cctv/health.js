/**
 * Vercel port of vite.config.js's /api/cctv/health. NOTE: the original proxy
 * tracks per-camera health in an in-memory map updated by the frame/media
 * routes. On Vercel each API route is its own isolated serverless function
 * (no shared memory across files/instances), so that map can't be
 * meaningfully populated here — this endpoint returns an empty (but
 * correctly-shaped) report rather than fabricating state. A future version
 * could persist health to a shared store (Vercel KV / Upstash) if per-camera
 * health needs to work in production.
 */
export default async function handler(req, res) {
  res.status(200).setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify({ cameras: [] }));
}
