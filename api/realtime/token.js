/**
 * Vercel port of vite.config.js's openAiRealtimeProxy() /api/realtime/token
 * route — mints an ephemeral OpenAI Realtime WebRTC client secret, keeping
 * OPENAI_API_KEY server-side. Session config (instructions + tools) is
 * shared verbatim with the dev-server route via api/_lib/realtimeVoiceConfig.js.
 */
import { VOICE_MODELS, isKnownVoiceTier, resolveVoiceModel } from '../../src/voice/voiceCost.js';
import { GEV_REALTIME_INSTRUCTIONS, GEV_REALTIME_TOOLS } from '../_lib/realtimeVoiceConfig.js';

const OPENAI_REALTIME_MODEL_DEFAULT = VOICE_MODELS.standard.id;
const OPENAI_REALTIME_MODEL_MINI_DEFAULT = VOICE_MODELS.mini.id;
const OPENAI_REALTIME_VOICE_DEFAULT = 'marin';
const OPENAI_REALTIME_REASONING_DEFAULT = 'low';
const OPENAI_REALTIME_CONTEXT_TOKENS_DEFAULT = 3000;
const OPENAI_REALTIME_CONTEXT_RETENTION_DEFAULT = 0.5;

export default async function handler(req, res) {
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
