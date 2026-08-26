/**
 * Consolidated hub for OpenAI-backed voice routes (Vercel Hobby plan's 12
 * Serverless Function cap forces route consolidation — see vercel.json
 * rewrites). Dispatches on `req.query.__r`. Keeps OPENAI_API_KEY server-side.
 *
 * Routes folded in (original file → __r key):
 *   api/openai/hud-summary.js → hud-summary
 *   api/realtime/token.js     → token
 */
import { VOICE_MODELS, isKnownVoiceTier, resolveVoiceModel } from '../src/voice/voiceCost.js';
import { GEV_REALTIME_INSTRUCTIONS, GEV_REALTIME_TOOLS } from './_lib/realtimeVoiceConfig.js';

/** Folded in from api/openai/hud-summary.js (__r=hud-summary, POST). */
const OPENAI_HUD_SUMMARY_MODEL_DEFAULT = 'gpt-5-nano';

function extractOpenAiResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

async function handleHudSummary(req, res) {
  if (req.method !== 'POST') {
    res.status(405).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(503).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'OPENAI_API_KEY is not set' }));
    return;
  }
  try {
    const context = req.body && typeof req.body === 'object' ? req.body : {};
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_HUD_SUMMARY_MODEL || OPENAI_HUD_SUMMARY_MODEL_DEFAULT,
        instructions: [
          "Write one concise intelligence-HUD summary for God's Eye View.",
          'Use only the supplied place, street, nearby-place, and enabled-layer text labels.',
          'Prefer the clearest named place and include a relevant enabled layer only when useful.',
          'Do not infer from coordinates or invent a place.',
          'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
        ].join(' '),
        input: JSON.stringify(context),
        reasoning: { effort: 'minimal' },
        max_output_tokens: 100,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => ({}));
    const summary = toFiveWordHudSummary(extractOpenAiResponseText(data));
    res.status(response.ok && summary ? 200 : response.status || 502);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify({
      summary: summary || null,
      error: response.ok ? null : data.error?.message || 'OpenAI HUD summary request failed',
    }));
  } catch (error) {
    res.status(502).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: error?.message || 'OpenAI HUD summary request failed' }));
  }
}

/**
 * Folded in from api/realtime/token.js (__r=token, GET or POST) — mints an
 * ephemeral OpenAI Realtime WebRTC client secret. Session config
 * (instructions + tools) is shared verbatim with the dev-server route via
 * api/_lib/realtimeVoiceConfig.js.
 */
const OPENAI_REALTIME_MODEL_DEFAULT = VOICE_MODELS.standard.id;
const OPENAI_REALTIME_MODEL_MINI_DEFAULT = VOICE_MODELS.mini.id;
const OPENAI_REALTIME_VOICE_DEFAULT = 'marin';
const OPENAI_REALTIME_REASONING_DEFAULT = 'low';
const OPENAI_REALTIME_CONTEXT_TOKENS_DEFAULT = 3000;
const OPENAI_REALTIME_CONTEXT_RETENTION_DEFAULT = 0.5;

async function handleRealtimeToken(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(503).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'OPENAI_API_KEY is not set' }));
    return;
  }

  const requestedTier = (() => {
    try { return new URL(req.url || '', 'http://localhost').searchParams.get('tier'); } catch { return null; }
  })();
  const tier = resolveVoiceModel(requestedTier).tier;
  const model = tier === 'mini'
    ? process.env.OPENAI_REALTIME_MODEL_MINI || OPENAI_REALTIME_MODEL_MINI_DEFAULT
    : process.env.OPENAI_REALTIME_MODEL || OPENAI_REALTIME_MODEL_DEFAULT;
  const voice = process.env.OPENAI_REALTIME_VOICE || OPENAI_REALTIME_VOICE_DEFAULT;
  const effort = process.env.OPENAI_REALTIME_REASONING_EFFORT || OPENAI_REALTIME_REASONING_DEFAULT;
  const contextTokenLimit = Math.round(Math.max(1000, Math.min(12000, Number(process.env.OPENAI_REALTIME_CONTEXT_TOKENS) || OPENAI_REALTIME_CONTEXT_TOKENS_DEFAULT)));
  const contextRetentionRatio = Math.max(0.1, Math.min(1, Number(process.env.OPENAI_REALTIME_CONTEXT_RETENTION) || OPENAI_REALTIME_CONTEXT_RETENTION_DEFAULT));

  const sessionConfig = {
    session: {
      type: 'realtime',
      model,
      reasoning: { effort },
      truncation: {
        type: 'retention_ratio',
        retention_ratio: contextRetentionRatio,
        token_limits: { post_instructions: contextTokenLimit },
      },
      audio: {
        input: {
          noise_reduction: { type: 'near_field' },
          turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: false },
        },
        output: { voice },
      },
      instructions: GEV_REALTIME_INSTRUCTIONS,
      tools: GEV_REALTIME_TOOLS,
      tool_choice: 'auto',
    },
  };

  try {
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Safety-Identifier': 'gev-vercel-deployed',
      },
      body: JSON.stringify(sessionConfig),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.text();
    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    res.setHeader('X-GEV-Voice-Tier', tier);
    res.setHeader('X-GEV-Voice-Model', model);
    if (requestedTier && !isKnownVoiceTier(requestedTier)) {
      res.setHeader('X-GEV-Voice-Tier-Fallback', '1');
    }
    res.send(body);
  } catch (error) {
    res.status(502).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: error?.message || 'Failed to create Realtime token' }));
  }
}

export default async function handler(req, res) {
  try {
    const route = req.query?.__r;
    if (route === 'hud-summary') return handleHudSummary(req, res);
    if (route === 'token') return handleRealtimeToken(req, res);
    res.status(404).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'unknown_route' }));
  } catch (err) {
    console.error('[voice hub]', err?.message || err);
    if (!res.headersSent) {
      res.status(500).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'internal_error', message: String(err?.message || err) }));
    }
  }
}
