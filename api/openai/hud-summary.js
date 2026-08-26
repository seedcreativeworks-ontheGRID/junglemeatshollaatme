/**
 * Vercel port of vite.config.js's openAiRealtimeProxy() /api/openai/hud-summary
 * route. Keeps OPENAI_API_KEY server-side.
 */
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

export default async function handler(req, res) {
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
