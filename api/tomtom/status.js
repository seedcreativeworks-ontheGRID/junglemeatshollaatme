/**
 * Vercel port of vite.config.js's /api/tomtom/status. See api/tomtom/flow/[z]/[x]/[y].js
 * for the budget-governor caveat (best-effort, in-memory, resets on cold start).
 */
import { utcDayKey, normalizeBudget } from '../../src/data/tomtomTiles.js';

const DEFAULT_DAILY_BUDGET = 40000;
let budget = null;

function dailyBudgetLimit() {
  const raw = Number.parseInt(process.env.TOMTOM_DAILY_TILE_BUDGET || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET;
}

export function currentBudget() {
  budget = normalizeBudget(budget, utcDayKey());
  return budget;
}

export default async function handler(req, res) {
  try {
    const hasKey = Boolean(process.env.TOMTOM_API_KEY);
    const b = currentBudget();
    res.status(200).setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify({ hasKey, dailyCount: b.count, budget: dailyBudgetLimit(), date: b.date }));
  } catch (error) {
    console.error('[tomtom-status]', error?.message || error);
    if (!res.headersSent) {
      res.status(500).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'internal_error', message: String(error?.message || error) }));
    }
  }
}
