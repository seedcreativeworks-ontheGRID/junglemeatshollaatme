# Deploying to Vercel

God's Eye View normally runs via `vite dev`, whose `vite.config.js` registers
~19 dev-server-only proxy middlewares (`configureServer` hooks) that talk to
OpenSky, CelesTrak, Overpass, GBFS, CCTV sources, adsb.lol, AIS Stream,
terrain heights, TomTom, NASA FIRMS, military installations, regional
briefing, weather, rocket launches, Radio Browser, adsbdb, OpenAI Realtime
voice, and Google Places. Those middlewares only exist inside the dev
server — a `vite build` produces a static `dist/` with no server, and
`configureServer` never runs on Vercel.

This repo now also ships a parallel `/api/*` directory of Vercel serverless
functions that reimplement the same routes (upstream URLs, env vars, and
response shapes match the dev-server proxies). `npm run dev` is unaffected —
`vite.config.js` was not touched, so local dev keeps using its own
middlewares. The `/api/*` files are used only when deployed to Vercel.

## a) Deploying

1. Push this repo to GitHub (already done if you're reading this in the
   repo).
2. Go to [vercel.com](https://vercel.com) → **Add New… → Project** → import
   this GitHub repository.
3. Vercel auto-detects the `vercel.json` at the repo root
   (`{"buildCommand": "vite build", "outputDirectory": "dist", "framework": "vite"}`)
   — no build configuration changes are needed.
4. Add the environment variables you want (see the table below) under
   **Project Settings → Environment Variables**, then deploy (or redeploy).
5. `/api/*` requests are served by the serverless functions in this repo;
   everything else falls through to the static `dist/` build. Vercel's Vite
   framework preset does not rewrite `/api/*` to `index.html`, so this needs
   no extra `rewrites` config in `vercel.json`.

## b) Environment variables

All of these are optional unless noted — every layer that needs a missing
key degrades gracefully (a simulated/keyless fallback, or an honest
"unavailable" state) rather than breaking the app.

| Variable | Used by | Notes |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | `/api/cctv/frame/*` (Street View fallback), `/api/google/*` | Also injected client-side for map tiles — restrict it in Google Cloud (HTTP referrer + API restriction). |
| `CESIUM_ION_TOKEN` | client bundle | Client-exposed by design; use a scoped public token. |
| `OPENAI_API_KEY` | `/api/openai/hud-summary`, `/api/realtime/token` | Required for the voice-control HUD summary and mic session. |
| `OPENAI_REALTIME_MODEL` | `/api/realtime/token` | Defaults to the standard voice tier model. |
| `OPENAI_REALTIME_MODEL_MINI` | `/api/realtime/token` | Defaults to the mini voice tier model. |
| `OPENAI_REALTIME_VOICE` | `/api/realtime/token` | Default `marin`. |
| `OPENAI_REALTIME_REASONING_EFFORT` | `/api/realtime/token` | Default `low`. |
| `OPENAI_REALTIME_CONTEXT_TOKENS` | `/api/realtime/token` | Default `3000`. |
| `OPENAI_REALTIME_CONTEXT_RETENTION` | `/api/realtime/token` | Default `0.5`. |
| `OPENAI_HUD_SUMMARY_MODEL` | `/api/openai/hud-summary` | Default `gpt-5-nano`. |
| `OPENSKY_AUTH_MODE` | `/api/opensky` | `oauth` (default) \| `basic` \| `auto` \| `anon`. |
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | `/api/opensky`, `/api/opensky-track` | OAuth client_credentials, from your OpenSky account dashboard. |
| `OPENSKY_USERNAME` / `OPENSKY_PASSWORD` | `/api/opensky` | Only used in `basic`/`auto` auth mode. Undocumented in `.env.example` but read by the proxy. |
| `FIRMS_MAP_KEY` | `/api/firms`, `/api/firms/status` | Free key from https://firms.modaps.eosdis.nasa.gov/api/map_key/. Without it, the FIRMS layer reports `no_key` and stays empty. |
| `TOMTOM_API_KEY` | `/api/tomtom/flow/*`, `/api/tomtom/status` | Without it, tile requests 503 `{error:'no_key'}` — the client already falls back to simulated traffic. |
| `TOMTOM_DAILY_TILE_BUDGET` | `/api/tomtom/flow/*` | Default `40000`. See the budget-governor caveat below. |
| `LL2_API_TOKEN` | `/api/launches` | Optional Launch Library 2 API token, sent as `Authorization: Token <token>`. Undocumented in `.env.example` but read by the proxy. |
| `AISSTREAM_API_KEY` | — | **Not used on Vercel.** See the AIS live callout below. |
| `CCTV_SOURCES_FILE` / `CCTV_SOURCES_JSON` | `/api/cctv/sources`, `/api/cctv/frame/*` | Override the static camera source pack. |
| `CCTV_AUSTIN_ROWS_URL` / `CCTV_AUSTIN_MAX_SOURCES` | `/api/cctv/sources` | Austin Open Data catalog tuning. |
| `CCTV_CALTRANS_DISTRICTS` | `/api/cctv/sources` | Comma-separated Caltrans districts (1-12). Default `4,7,11,3`. Undocumented in `.env.example` but read by the proxy. |
| `CCTV_CALTRANS_MAX_SOURCES` | `/api/cctv/sources` | Cap on Caltrans cameras loaded. Undocumented in `.env.example` but read by the proxy. |
| `CCTV_TFL_ENABLED` | `/api/cctv/sources` | Set to `0` to disable the TfL JamCam pack. Undocumented in `.env.example` but read by the proxy. |
| `TFL_APP_KEY` | `/api/cctv/sources` | Optional TfL API key (raises the list-endpoint rate limit only). Undocumented in `.env.example` but read by the proxy. |
| `CCTV_MAX_SOURCES` / `CCTV_PREFER_AUSTIN` / `CCTV_FORCE_AUSTIN` | `/api/cctv/sources` | Overall catalog tuning — see `.env.example`. |

## c) AIS live vessel tracking is unavailable on Vercel

The real `/api/ais-live` proxy holds a **persistent outbound WebSocket** to
`wss://stream.aisstream.io/v0/stream` inside the long-running dev-server
process, continuously accumulating vessel state in memory. A stateless
serverless function has no equivalent — there is no process that outlives a
single request to hold that socket open, so `AISSTREAM_API_KEY` is not read
on Vercel at all.

`/api/ais-live.js` and `/api/ais-live/track.js` instead return a 200 JSON
response in the same shape the real proxy uses
(`{rows: [], source: 'unavailable', status: 'unavailable', error: '…', refreshing: false}`),
which the client's existing AIS "unavailable" UI state
(`src/data/aisLiveVessels.js`) already renders gracefully — the layer shows
as offline rather than throwing.

Two ways to get real live AIS tracking:

1. **Run locally**: `npm run dev` uses the real dev-server proxy with its
   persistent WebSocket, so AIS live works exactly as designed.
2. **Future work — an always-on relay**: stand up a small always-on service
   (e.g. on Render, Fly.io, or a tiny VM) that maintains the AISStream
   WebSocket connection itself and exposes an HTTP endpoint with the
   accumulated vessel snapshot. Then point `/api/ais-live` (and
   `/api/ais-live/track`) at that relay instead of AISStream directly. This
   is not implemented in this repo.

## d) TomTom daily tile budget is approximate on Vercel

The original dev-server proxy persists its daily tile-fetch counter to disk
(`.gev-cache/tomtom/budget.json`), so the budget governor is accurate across
restarts. Vercel serverless functions have no persistent disk (only an
ephemeral `/tmp` that isn't guaranteed to survive between invocations, and
isn't used here), so `/api/tomtom/flow/[z]/[x]/[y].js` keeps the counter as a
plain in-memory variable instead:

- It **resets to 0 on every cold start** (a new lambda instance starts
  counting from zero).
- It is **not shared across concurrent instances** — Vercel may run several
  warm instances of the same function in parallel under load, and each has
  its own counter.

This means the configured `TOMTOM_DAILY_TILE_BUDGET` is a soft, per-instance
approximation rather than a real shared daily cap. If you need an accurate
cross-instance budget, wire up a shared store — Vercel KV or Upstash Redis
are natural fits — and swap the in-memory counter for reads/writes against
it. That integration is intentionally not implemented here to keep this port
simple; the code has a comment at the counter noting exactly this.

## Other simplifications in the Vercel port

A few routes trade some of the dev-server proxy's caching sophistication for
simplicity, since Vercel functions can't share disk or memory across
instances/cold-starts the way the long-lived dev server can. None of these
affect correctness of the upstream calls themselves:

- **All in-memory caches** (`/api/opensky`, `/api/celestrak/*`,
  `/api/overpass`, `/api/firms`, `/api/military-installations`,
  `/api/regional-brief`, `/api/weather-effects`, `/api/launches`,
  `/api/adsbdb/*`, `/api/opensky-track`, `/api/adsblol/*`, `/api/cctv/*`) are
  plain module-scope variables — best-effort, per-warm-instance only, no
  disk persistence. A cold start or a second concurrent instance sees an
  empty cache.
- **`/api/cctv/health`** cannot meaningfully report per-camera health,
  because health state is written by the frame/media routes, which are
  separate serverless functions with no shared memory. It returns an
  empty-but-correctly-shaped report instead of fabricating data.
- **`/api/radio/stations`** skips the dev-server proxy's DNS-level SSRF
  pinning for outbound Radio Browser requests (Vercel functions already run
  each invocation in an isolated sandbox) and merges one broad
  popularity-sorted station query instead of the original's nine parallel
  tag-scoped queries.
- **Opt-in per-IP rate limiting** (`GEV_RATELIMIT_OPENAI_PER_MIN`,
  `GEV_RATELIMIT_GOOGLE_PER_MIN`) from the dev-server proxy is not
  reimplemented in the Vercel port.
- **`/api/cctv/stream/:id`** and **`/api/realtime/debug-log`** are not
  ported. The stream-info route is lower priority (the client's primary path
  is `/api/cctv/frame/:id`); the debug-log route is a local-disk logger the
  client calls fire-and-forget (via `sendBeacon`/best-effort `fetch`, always
  swallowing errors) — a 404 for it is harmless and does not affect voice
  control.
