/**
 * Shared OpenSky OAuth2 client_credentials token helper — used by both
 * /api/opensky.js and /api/opensky-track.js, mirroring vite.config.js's
 * getOpenSkyToken(). Module-scope cache: best-effort, resets on cold start.
 */

let _openskyToken = null;
let _openskyTokenExpiry = 0;
let _openskyTokenPromise = null;
let _openskyAuthWarned = false;

export async function getOpenSkyToken() {
  const now = Date.now();
  if (_openskyToken && now < _openskyTokenExpiry - 60000) return _openskyToken;
  if (_openskyTokenPromise) return _openskyTokenPromise;

  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  _openskyTokenPromise = (async () => {
    try {
      const res = await fetch(
        'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
        },
      );
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      const accessToken = data?.access_token;
      const expiresIn = Number(data?.expires_in);
      if (!res.ok || !accessToken) {
        if (!_openskyAuthWarned) {
          console.warn('[OpenSky] OAuth client_credentials failed:', data?.error_description || data?.error || `HTTP ${res.status}`);
          _openskyAuthWarned = true;
        }
        _openskyToken = null;
        _openskyTokenExpiry = 0;
        return null;
      }
      _openskyToken = accessToken;
      _openskyTokenExpiry = Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 1800) * 1000;
      _openskyAuthWarned = false;
      return _openskyToken;
    } catch (err) {
      if (!_openskyAuthWarned) {
        console.warn('[OpenSky] OAuth token request failed:', err?.message || String(err));
        _openskyAuthWarned = true;
      }
      _openskyToken = null;
      _openskyTokenExpiry = 0;
      return null;
    } finally {
      _openskyTokenPromise = null;
    }
  })();

  return _openskyTokenPromise;
}
