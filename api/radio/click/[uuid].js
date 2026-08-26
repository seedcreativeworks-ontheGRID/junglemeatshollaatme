/**
 * Vercel port of vite.config.js's radioBrowserProxy() POST /click/:id route.
 * Fires the click-count ping to Radio Browser and returns 204 immediately
 * (fire-and-forget, matching the original). Station-id membership in the
 * served catalog is not re-checked here (that check lived against the
 * dev-server's in-memory catalog instance, which this stateless function
 * doesn't share) — only UUID shape is validated.
 */
import { RADIO_UUID_RE } from '../../_lib/radioStation.js';

const RADIO_FALLBACK_MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).setHeader('Cache-Control', 'no-store');
    res.send('');
    return;
  }
  const id = String(req.query?.uuid || '').toLowerCase();
  if (!RADIO_UUID_RE.test(id)) {
    res.status(404).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'Unknown radio station' }));
    return;
  }
  // Serverless functions are not guaranteed to keep running background work
  // after the response is sent (unlike the long-lived dev-server process),
  // so this is awaited (with a short timeout) rather than truly fire-and-forget.
  try {
    await fetch(`${RADIO_FALLBACK_MIRRORS[0]}/json/url/${id}`, {
      headers: { 'User-Agent': 'gods-eye-view-radio-proxy/1.0' },
      signal: AbortSignal.timeout(4000),
    });
  } catch { /* best-effort click ping */ }
  res.status(204).setHeader('Cache-Control', 'no-store');
  res.end();
}
