/**
 * Shared CCTV catalog builder + frame-fallback helpers, ported from
 * vite.config.js's cctvProxy() and its Austin/Caltrans/TfL loaders. Used by
 * api/cctv/sources.js, api/cctv/health.js, api/cctv/frame/[id].js, and
 * api/cctv/media/[id].js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { directionToHeading } from '../../src/data/directionText.js';
import { haversineKm } from './http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_CCTV_SOURCE_FILE = 'config/cctv_sources.austin.json';
const DEFAULT_AUSTIN_ROWS_URL = 'https://data.austintexas.gov/api/views/b4k4-adkb/rows.json?accessType=DOWNLOAD';
const DEFAULT_AUSTIN_MAX_SOURCES = 250;
const DEFAULT_CCTV_MAX_SOURCES = 900;
const AUSTIN_DOWNTOWN = { lat: 30.2672, lon: -97.7431 };
const CALTRANS_CCTV_URL = (district) =>
  `https://cwwp2.dot.ca.gov/data/d${district}/cctv/cctvStatusD${String(district).padStart(2, '0')}.json`;
const DEFAULT_CALTRANS_DISTRICTS = '4,7,11,3';
const DEFAULT_CALTRANS_MAX_SOURCES = 300;
const CALTRANS_ANCHORS = [
  { lat: 37.7793, lon: -122.4193 },
  { lat: 34.0537, lon: -118.2428 },
  { lat: 32.7157, lon: -117.1611 },
  { lat: 38.5816, lon: -121.4944 },
];
const TFL_JAMCAM_URL = 'https://api.tfl.gov.uk/Place/Type/JamCam';
const TFL_IMAGE_ORIGIN = 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/';
const DEFAULT_TFL_MAX_SOURCES = 250;
const LONDON_CENTER = { lat: 51.5074, lon: -0.1278 };
const CCTV_SOURCE_CACHE_MS = 15 * 60 * 1000;
const CCTV_SOURCE_FETCH_TIMEOUT_MS = 15 * 1000;
export const CCTV_FRAME_FETCH_TIMEOUT_MS = 8 * 1000;

let _cctvSourceCache = [];
let _cctvSourceCacheAt = 0;
let _cctvSourceInflight = null;

function toFiniteNumber(value, fallback = NaN) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeKey(text) {
  return String(text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function hashSeed(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function normalizeFeedType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'image';
  if (raw === 'jpeg' || raw === 'jpg' || raw === 'png') return 'image';
  if (raw === 'mjpg') return 'mjpeg';
  if (raw === 'video') return 'mp4';
  if (raw === 'stream') return 'hls';
  return raw;
}

export function isVideoFeedType(feedType) {
  return feedType === 'mp4' || feedType === 'webm' || feedType === 'hls';
}

function loadSourcesFromFile() {
  const sourceFile = process.env.CCTV_SOURCES_FILE || DEFAULT_CCTV_SOURCE_FILE;
  const resolved = path.isAbsolute(sourceFile) ? sourceFile : path.resolve(REPO_ROOT, sourceFile);
  try {
    if (!fs.existsSync(resolved)) return [];
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('[CCTV] failed to read source file:', resolved, error?.message || error);
    return [];
  }
}

function loadSourcesFromEnv() {
  const raw = process.env.CCTV_SOURCES_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function parsePointString(value) {
  const match = String(value || '').match(/POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
  if (!match) return { lat: NaN, lon: NaN };
  return { lon: toFiniteNumber(match[1]), lat: toFiniteNumber(match[2]) };
}

function coerceLatLon(value) {
  if (!value) return { lat: NaN, lon: NaN };
  if (typeof value === 'string') return parsePointString(value);
  if (typeof value !== 'object') return { lat: NaN, lon: NaN };
  const lat = toFiniteNumber(value.latitude ?? value.lat ?? value.y ?? value.Latitude ?? value.Lat, NaN);
  const lon = toFiniteNumber(value.longitude ?? value.lon ?? value.lng ?? value.x ?? value.Longitude ?? value.Lon, NaN);
  return { lat, lon };
}

function extractAustinCoords(record) {
  const candidates = [record.location, record.coordinates, record.the_geom, record.point, record.geocoded_column];
  for (const candidate of candidates) {
    const parsed = coerceLatLon(candidate);
    if (Number.isFinite(parsed.lat) && Number.isFinite(parsed.lon)) return parsed;
  }
  const lat = toFiniteNumber(record.latitude ?? record.lat ?? record.camera_latitude ?? record.location_latitude, NaN);
  const lon = toFiniteNumber(record.longitude ?? record.lon ?? record.lng ?? record.camera_longitude ?? record.location_longitude, NaN);
  return { lat, lon };
}

function extractAustinCameraId(record) {
  const preferredKeys = ['camera_id', 'cameraid', 'cam_id', 'device_id', 'intersection_id', 'id'];
  for (const key of preferredKeys) {
    const value = record[key];
    if (value == null) continue;
    const asText = String(value).trim();
    if (asText && /^\d+$/.test(asText)) return asText;
  }
  for (const [key, value] of Object.entries(record)) {
    if (!/camera|cam|device/.test(key) || !/id/.test(key)) continue;
    const asText = String(value || '').trim();
    if (asText && /^\d+$/.test(asText)) return asText;
  }
  return '';
}

function extractAustinName(record, cameraId) {
  const preferredKeys = ['camera_name', 'location_name', 'intersection_name', 'location', 'cross_street', 'description', 'name'];
  for (const key of preferredKeys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return `Austin Camera ${cameraId}`;
}

function extractAustinHeading(record) {
  const direct = toFiniteNumber(record.heading_deg ?? record.heading ?? record.bearing, NaN);
  if (Number.isFinite(direct)) return ((direct % 360) + 360) % 360;
  const directionKeys = ['direction', 'travel_direction', 'facing', 'facing_direction'];
  for (const key of directionKeys) {
    const heading = directionToHeading(record[key], true);
    if (Number.isFinite(heading)) return heading;
  }
  const nameProbe = [record.camera_name, record.location_name, record.intersection_name, record.location, record.cross_street, record.description, record.name]
    .filter(Boolean).join(' ');
  const inferred = directionToHeading(nameProbe);
  return Number.isFinite(inferred) ? inferred : NaN;
}

function isLikelyAustinCoordinate(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= 30.02 && lat <= 30.58 && lon >= -98.12 && lon <= -97.40;
}

function fallbackHeadingFromId(cameraId) {
  return (hashSeed(String(cameraId)) % 16) * 22.5;
}

function rowArrayToObject(row, columns) {
  const record = {};
  for (let idx = 0; idx < columns.length; idx++) {
    const col = columns[idx];
    const key = normalizeKey(col.fieldName || col.name || `col_${idx}`);
    if (key) record[key] = row[idx];
  }
  return record;
}

function prioritizeSources(cameras, maxCount, anchors) {
  const list = Array.isArray(cameras) ? cameras : [];
  const anchorList = (Array.isArray(anchors) ? anchors : []).filter((a) => Number.isFinite(a?.lat) && Number.isFinite(a?.lon));
  if (!Number.isFinite(maxCount) || maxCount <= 0 || list.length <= maxCount || !anchorList.length) return list;
  const scored = list.map((camera, idx) => {
    const lat = Number(camera?.lat);
    const lon = Number(camera?.lon);
    const distKm = Number.isFinite(lat) && Number.isFinite(lon)
      ? Math.min(...anchorList.map((a) => haversineKm(lat, lon, a.lat, a.lon)))
      : Number.POSITIVE_INFINITY;
    return { camera, idx, distKm };
  });
  scored.sort((a, b) => (a.distKm !== b.distKm ? a.distKm - b.distKm : a.idx - b.idx));
  return scored.slice(0, maxCount).map((entry) => entry.camera);
}

async function loadAustinSourcesFromOpenData() {
  const endpoint = process.env.CCTV_AUSTIN_ROWS_URL || DEFAULT_AUSTIN_ROWS_URL;
  try {
    const resp = await fetch(endpoint, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS) });
    if (!resp.ok) { console.warn('[CCTV] Austin source download failed:', resp.status); return []; }
    const payload = await resp.json();
    const columns = Array.isArray(payload?.meta?.view?.columns) ? payload.meta.view.columns : [];
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    if (!columns.length || !rows.length) return [];
    const cameras = [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const record = rowArrayToObject(row, columns);
      const cameraId = extractAustinCameraId(record);
      if (!cameraId) continue;
      const status = String(record.camera_status || '').trim().toUpperCase();
      if (status && status !== 'TURNED_ON') continue;
      const { lat, lon } = extractAustinCoords(record);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !isLikelyAustinCoordinate(lat, lon)) continue;
      const extractedHeading = extractAustinHeading(record);
      const hasHeading = Number.isFinite(extractedHeading);
      const headingDeg = hasHeading ? extractedHeading : fallbackHeadingFromId(cameraId);
      cameras.push({
        id: cameraId,
        name: extractAustinName(record, cameraId),
        city: 'Austin',
        cityId: 'austin',
        provider: 'Austin Transportation & Public Works',
        lat, lon, headingDeg,
        headingConfidence: hasHeading ? 'high' : 'low',
        pitchDeg: hasHeading ? -24 : -18,
        fovDeg: hasHeading ? 56 : 44,
        rangeM: hasHeading ? 210 : 145,
        mountHeightM: hasHeading ? 10 : 8,
        groundElevationM: 150,
        feedType: 'image',
        url: `https://cctv.austinmobility.io/image/${encodeURIComponent(cameraId)}.jpg`,
        snapshotUrl: `https://cctv.austinmobility.io/image/${encodeURIComponent(cameraId)}.jpg`,
        sourceKind: 'austin-open-data',
        license: 'Public city traffic camera frame',
      });
    }
    const unique = Array.from(new Map(cameras.map((camera) => [camera.id, camera])).values());
    const maxRaw = Number(process.env.CCTV_AUSTIN_MAX_SOURCES || DEFAULT_AUSTIN_MAX_SOURCES);
    const maxCount = Number.isFinite(maxRaw) ? Math.max(8, Math.min(300, Math.floor(maxRaw))) : DEFAULT_AUSTIN_MAX_SOURCES;
    return prioritizeSources(unique, maxCount, [AUSTIN_DOWNTOWN]);
  } catch (error) {
    console.warn('[CCTV] Austin source download error:', error?.message || error);
    return [];
  }
}

async function loadCaltransSourcesFromOpenData() {
  const districtsRaw = process.env.CCTV_CALTRANS_DISTRICTS ?? DEFAULT_CALTRANS_DISTRICTS;
  const districts = String(districtsRaw).split(',').map((token) => Number(token.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);
  if (!districts.length) return [];
  const settled = await Promise.allSettled(districts.map(async (district) => {
    const resp = await fetch(CALTRANS_CCTV_URL(district), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`D${district} HTTP ${resp.status}`);
    const payload = await resp.json();
    return { district, rows: Array.isArray(payload?.data) ? payload.data : [] };
  }));
  const cameras = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') { console.warn('[CCTV] Caltrans district fetch failed:', result.reason?.message || result.reason); continue; }
    const { district, rows } = result.value;
    for (const row of rows) {
      const cctv = row?.cctv;
      if (!cctv || String(cctv.inService).toLowerCase() !== 'true') continue;
      const loc = cctv.location || {};
      const lat = toFiniteNumber(loc.latitude);
      const lon = toFiniteNumber(loc.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const imageUrl = String(cctv.imageData?.static?.currentImageURL || '');
      if (!imageUrl.startsWith('https://cwwp2.dot.ca.gov/')) continue;
      const locationName = String(loc.locationName || '').trim();
      const codeMatch = /^([A-Za-z0-9_-]+)\s*--/.exec(locationName);
      const code = (codeMatch ? codeMatch[1] : `x${cameras.length}`).toLowerCase();
      const cameraId = `ca-d${district}-${code}`;
      const heading = directionToHeading(loc.direction, true);
      const hasHeading = Number.isFinite(heading);
      const label = locationName.replace(/^([A-Za-z0-9_-]+)\s*--\s*/, '') || `Caltrans D${district} ${code}`;
      cameras.push({
        id: cameraId,
        name: loc.nearbyPlace ? `${label} (${loc.nearbyPlace})` : label,
        city: String(loc.nearbyPlace || `Caltrans D${district}`),
        cityId: `ca-d${district}`,
        provider: 'Caltrans',
        lat, lon,
        headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
        headingConfidence: hasHeading ? 'high' : 'low',
        pitchDeg: hasHeading ? -24 : -18,
        fovDeg: hasHeading ? 56 : 44,
        rangeM: hasHeading ? 210 : 145,
        mountHeightM: hasHeading ? 10 : 8,
        groundElevationM: (() => {
          const ft = toFiniteNumber(loc.elevation, NaN);
          return Number.isFinite(ft) ? Math.max(-100, Math.min(4000, ft * 0.3048)) : 150;
        })(),
        feedType: 'image',
        url: imageUrl,
        snapshotUrl: imageUrl,
        sourceKind: 'caltrans-open-data',
        license: 'Public Caltrans highway camera frame',
      });
    }
  }
  const maxRaw = Number(process.env.CCTV_CALTRANS_MAX_SOURCES || DEFAULT_CALTRANS_MAX_SOURCES);
  const maxCount = Number.isFinite(maxRaw) ? Math.max(8, Math.min(600, Math.floor(maxRaw))) : DEFAULT_CALTRANS_MAX_SOURCES;
  return prioritizeSources(cameras, maxCount, CALTRANS_ANCHORS);
}

async function loadTflSourcesFromOpenData() {
  try {
    const appKey = String(process.env.TFL_APP_KEY || '').trim();
    const url = appKey ? `${TFL_JAMCAM_URL}?app_key=${encodeURIComponent(appKey)}` : TFL_JAMCAM_URL;
    const resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS) });
    if (!resp.ok) { console.warn('[CCTV] TfL JamCam download failed:', resp.status); return []; }
    const places = await resp.json();
    if (!Array.isArray(places)) return [];
    const cameras = [];
    for (const place of places) {
      const props = {};
      for (const p of place?.additionalProperties || []) if (p?.key) props[p.key] = p.value;
      if (String(props.available).toLowerCase() !== 'true') continue;
      const lat = toFiniteNumber(place?.lat);
      const lon = toFiniteNumber(place?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const imageUrl = String(props.imageUrl || '');
      if (!imageUrl.startsWith(TFL_IMAGE_ORIGIN)) continue;
      const rawId = String(place?.id || '').replace(/^JamCams_/, '');
      if (!rawId) continue;
      const cameraId = `tfl-${rawId}`;
      cameras.push({
        id: cameraId,
        name: String(place?.commonName || `JamCam ${rawId}`),
        city: 'London', cityId: 'london', provider: 'Transport for London',
        lat, lon,
        headingDeg: fallbackHeadingFromId(cameraId),
        headingConfidence: 'low', pitchDeg: -18, fovDeg: 44, rangeM: 145, mountHeightM: 8, groundElevationM: 15,
        feedType: 'image', url: imageUrl, snapshotUrl: imageUrl,
        sourceKind: 'tfl-open-data', license: 'Powered by TfL Open Data',
      });
    }
    const maxRaw = Number(process.env.CCTV_TFL_MAX_SOURCES || DEFAULT_TFL_MAX_SOURCES);
    const maxCount = Number.isFinite(maxRaw) ? Math.max(8, Math.min(600, Math.floor(maxRaw))) : DEFAULT_TFL_MAX_SOURCES;
    return prioritizeSources(cameras, maxCount, [LONDON_CENTER]);
  } catch (error) {
    console.warn('[CCTV] TfL JamCam download error:', error?.message || error);
    return [];
  }
}

function normalizeSourceItem(item) {
  return {
    id: String(item.id || '').trim(),
    name: String(item.name || item.id || '').trim(),
    city: String(item.city || ''),
    cityId: String(item.cityId || ''),
    provider: String(item.provider || 'Configured CCTV Source'),
    lat: toFiniteNumber(item.lat),
    lon: toFiniteNumber(item.lon),
    headingDeg: toFiniteNumber(item.headingDeg),
    headingConfidence: String(item.headingConfidence || item.headingSource || '').toLowerCase(),
    pitchDeg: toFiniteNumber(item.pitchDeg),
    fovDeg: toFiniteNumber(item.fovDeg),
    rangeM: toFiniteNumber(item.rangeM),
    mountHeightM: toFiniteNumber(item.mountHeightM),
    groundElevationM: toFiniteNumber(item.groundElevationM),
    feedType: normalizeFeedType(item.feedType || item.type || ''),
    url: typeof item.url === 'string' ? item.url : '',
    snapshotUrl: typeof item.snapshotUrl === 'string' ? item.snapshotUrl : '',
    license: String(item.license || item.licenseNote || ''),
    sourceKind: String(item.sourceKind || item.kind || 'configured'),
    poseSource: item.poseSource === 'curated' ? 'curated' : undefined,
  };
}

async function refreshCctvSources() {
  const fromFile = loadSourcesFromFile();
  const fromEnv = loadSourcesFromEnv();
  const forceAustin = String(process.env.CCTV_FORCE_AUSTIN || '').trim() === '1';
  const preferAustin = String(process.env.CCTV_PREFER_AUSTIN || '1').trim() !== '0';
  const needsLiveSources = forceAustin || ((fromFile.length + fromEnv.length) === 0 && preferAustin);
  const tflEnabled = String(process.env.CCTV_TFL_ENABLED || '1').trim() !== '0';

  let fromAustin = [];
  let fromCaltrans = [];
  let fromTfl = [];
  if (needsLiveSources) {
    const [austinResult, caltransResult, tflResult] = await Promise.allSettled([
      loadAustinSourcesFromOpenData(),
      loadCaltransSourcesFromOpenData(),
      tflEnabled ? loadTflSourcesFromOpenData() : Promise.resolve([]),
    ]);
    fromAustin = austinResult.status === 'fulfilled' ? austinResult.value : [];
    fromCaltrans = caltransResult.status === 'fulfilled' ? caltransResult.value : [];
    fromTfl = tflResult.status === 'fulfilled' ? tflResult.value : [];
  }
  const merged = [...fromAustin, ...fromCaltrans, ...fromTfl, ...fromFile, ...fromEnv];
  const byId = new Map();
  for (const item of merged) {
    if (!item || typeof item !== 'object') continue;
    const normalized = normalizeSourceItem(item);
    if (normalized.id) byId.set(normalized.id, normalized);
  }
  const mergedSources = Array.from(byId.values());
  const maxRaw = Number(process.env.CCTV_MAX_SOURCES || DEFAULT_CCTV_MAX_SOURCES);
  const maxCount = Number.isFinite(maxRaw) ? Math.max(8, Math.min(1200, Math.floor(maxRaw))) : DEFAULT_CCTV_MAX_SOURCES;
  const capped = mergedSources.length > maxCount ? mergedSources.slice(0, maxCount) : mergedSources;
  if (capped.length > 0 || _cctvSourceCache.length === 0) {
    _cctvSourceCache = capped;
  } else {
    console.warn(`[CCTV] source refresh returned empty; serving ${_cctvSourceCache.length} stale cameras`);
  }
  _cctvSourceCacheAt = Date.now();
  return _cctvSourceCache;
}

export async function getCctvSources() {
  const now = Date.now();
  if (_cctvSourceCache.length && now - _cctvSourceCacheAt <= CCTV_SOURCE_CACHE_MS) return _cctvSourceCache;
  if (_cctvSourceInflight) return _cctvSourceInflight;
  _cctvSourceInflight = refreshCctvSources().finally(() => { _cctvSourceInflight = null; });
  return _cctvSourceInflight;
}

export function buildSyntheticCctvSvg({ cameraId, label, city, status }) {
  const seed = hashSeed(`${cameraId}:${label}:${city}`);
  const hue = seed % 360;
  const hue2 = (hue + 46) % 360;
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').replace('Z', 'Z').slice(0, 20);
  const safeLabel = escapeXml(label);
  const safeCity = escapeXml(city || 'GLOBAL GRID');
  const safeId = escapeXml(cameraId);
  const safeStatus = escapeXml(status || 'SYNTHETIC');
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 35%, 10%)" />
      <stop offset="60%" stop-color="hsl(${hue2}, 42%, 6%)" />
      <stop offset="100%" stop-color="#020509" />
    </linearGradient>
    <radialGradient id="flare" cx="0.22" cy="0.24" r="0.78">
      <stop offset="0%" stop-color="hsla(${hue2}, 100%, 65%, 0.35)" />
      <stop offset="100%" stop-color="hsla(${hue2}, 100%, 40%, 0)" />
    </radialGradient>
    <pattern id="scan" width="8" height="8" patternUnits="userSpaceOnUse">
      <rect width="8" height="8" fill="transparent" />
      <rect y="0" width="8" height="1" fill="rgba(255,255,255,0.08)" />
      <rect y="4" width="8" height="1" fill="rgba(255,255,255,0.05)" />
    </pattern>
  </defs>
  <rect width="960" height="540" fill="url(#bg)" />
  <rect width="960" height="540" fill="url(#flare)" />
  <rect width="960" height="540" fill="url(#scan)" />
  <g stroke="rgba(123,233,255,0.25)" stroke-width="1" fill="none">
    <path d="M60 460 Q300 300 520 420 T900 320" />
    <path d="M100 160 Q340 40 620 130 T920 90" />
    <path d="M20 280 Q220 230 390 270 T760 250" />
  </g>
  <g fill="none" stroke="rgba(180,248,255,0.2)" stroke-width="1">
    <rect x="70" y="80" width="820" height="380" rx="8" />
    <line x1="70" y1="270" x2="890" y2="270" />
    <line x1="480" y1="80" x2="480" y2="460" />
  </g>
  <g fill="#9cefff" font-family="JetBrains Mono, monospace" text-transform="uppercase">
    <text x="74" y="54" font-size="16" letter-spacing="2">CCTV FEED PLACEHOLDER</text>
    <text x="74" y="512" font-size="14" letter-spacing="1.5">${safeLabel} · ${safeCity}</text>
    <text x="646" y="512" font-size="13" letter-spacing="1.2">${safeId}</text>
    <text x="704" y="54" font-size="15" letter-spacing="2">${escapeXml(ts)}</text>
    <text x="74" y="486" font-size="13" letter-spacing="1.3">${safeStatus}</text>
  </g>
</svg>`.trim();
}

export async function fetchCctvImageFromUpstream(url, { fetchImpl = fetch, timeoutMs = CCTV_FRAME_FETCH_TIMEOUT_MS } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException('CCTV upstream frame fetch timed out', 'TimeoutError'));
  }, timeoutMs);
  try {
    const upstream = await fetchImpl(url, {
      headers: { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' },
      signal: controller.signal,
    });
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !contentType.startsWith('image/')) return null;
    return { ok: true, body: Buffer.from(await upstream.arrayBuffer()), contentType };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function toReadable(body) {
  if (!body) return null;
  if (typeof body.pipe === 'function') return body;
  if (typeof body.getReader === 'function') return Readable.fromWeb(body);
  return null;
}

export async function proxyMediaResponse(res, upstream, { sourceHeader = 'upstream' } = {}) {
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const cacheControl = upstream.headers.get('cache-control') || 'no-store';
  const contentLength = upstream.headers.get('content-length');
  const contentRange = upstream.headers.get('content-range');
  const acceptRanges = upstream.headers.get('accept-ranges');
  res.status(upstream.status);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('X-CCTV-Source', sourceHeader);
  if (contentLength) res.setHeader('Content-Length', contentLength);
  if (contentRange) res.setHeader('Content-Range', contentRange);
  if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);

  const MEDIA_DECLARED_CAP_BYTES = 64 * 1024 * 1024;
  if (Number.isFinite(Number(contentLength)) && Number(contentLength) > MEDIA_DECLARED_CAP_BYTES) {
    res.status(502).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'Upstream media exceeds size cap' }));
    try { await upstream.body?.cancel(); } catch { /* no-op */ }
    return;
  }

  const stream = toReadable(upstream.body);
  if (!stream) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
    return;
  }
  stream.on('error', () => { if (!res.writableEnded) res.end(); });
  stream.pipe(res);
}
