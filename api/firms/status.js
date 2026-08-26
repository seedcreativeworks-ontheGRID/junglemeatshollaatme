/**
 * Vercel port of vite.config.js's /api/firms/status. NOTE: this is a
 * separate serverless function from api/firms.js, so it does NOT share the
 * `mem`/`inflight` fetch cache with that file — only the FIRMS mapkey_status
 * transaction-count cache lives here, matching the original route's own
 * independent 5-min TTL.
 */
const TTL_MS = 30 * 60_000;
const STATUS_TTL_MS = 5 * 60_000;

let statusCache = null;
let statusInflight = null;

function mapKey() {
  return String(process.env.FIRMS_MAP_KEY || '').trim();
}

function getTransactions(key) {
  const now = Date.now();
  if (statusCache && now - statusCache.at < STATUS_TTL_MS) return Promise.resolve(statusCache.transactions);
  if (!statusInflight) {
    statusInflight = (async () => {
      try {
        const url = `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${encodeURIComponent(key)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const used = Number(body?.current_transactions);
        const limit = Number(body?.transaction_limit);
        return Number.isFinite(used) && Number.isFinite(limit) ? { used, limit } : null;
      } catch (err) {
        console.warn('[firms-proxy] mapkey status failed:', err?.message || err);
        return null;
      }
    })()
      .then((transactions) => { statusCache = { at: Date.now(), transactions }; return transactions; })
      .finally(() => { statusInflight = null; });
  }
  return statusInflight;
}

export default async function handler(req, res) {
  const sendJson = (status, obj) => {
    res.status(status).setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(obj));
  };
  try {
    const key = mapKey();
    if (!key) {
      sendJson(200, { hasKey: false, lastFetch: null, count: null, stale: false, ttlMs: TTL_MS, transactions: null });
      return;
    }
    const transactions = await getTransactions(key);
    sendJson(200, { hasKey: true, lastFetch: null, count: null, stale: false, ttlMs: TTL_MS, transactions });
  } catch (err) {
    console.warn('[firms-proxy status] error:', err?.message || err);
    sendJson(500, { error: 'firms status proxy error' });
  }
}
