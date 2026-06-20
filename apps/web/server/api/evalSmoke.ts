// ─── Eval smoke run ───────────────────────────────────────────
// The on-demand, button-triggered path that makes the eval harness RUNNABLE from
// the dashboard (the "verify everything through the UI" bar). It runs the
// DETERMINISTIC `SMOKE_TASKS` suite — the exact subset CI runs: no live model, no
// provider keys, no executor / RuntimeAdapter, no network — against EPHEMERAL
// throwaway boards (temp-dir sqlite via `makeBoardContext`), returns the real
// `SuiteReport`, and cleans up. The real `clawboo.db` is never touched, so nothing
// pollutes the Board / Fleet / Obs views. The FULL live ablation (4 variants ×
// N trials with the live-model judge) stays CI-only — it is rendered + explained
// in the UI, never driven from here. Always available (no feature gate); co-located
// with the obs surface.

import { SMOKE_TASKS, cleanupEvalContexts, makeBoardContext, runSuite } from '@clawboo/evals'
import type { Request, Response } from 'express'

/** Clamp to [lo, hi]; non-finite / missing → fallback. Keeps the run bounded so
 *  the route can never be turned into a load generator. */
function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, Math.floor(n)))
}

// POST /api/eval/smoke — body { trials?, k? } (both clamped to [1,3]).
export async function evalSmokePOST(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { trials?: unknown; k?: unknown }
  const trials = clampInt(body.trials, 1, 3, 1)
  const k = clampInt(body.k, 1, 3, trials)
  try {
    // Each trial gets its own temp-dir sqlite board (disjoint from the real DB).
    const report = await runSuite(SMOKE_TASKS, () => Promise.resolve(makeBoardContext()), {
      trials,
      k,
    })
    res.json(report)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  } finally {
    cleanupEvalContexts()
  }
}
