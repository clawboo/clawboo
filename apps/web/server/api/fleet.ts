// ─── Fleet-health summary ────────────────────────────────────────────────────
// A READ-ONLY projection that aggregates existing tables/streams into one
// overview — it never recomputes or re-derives state:
//   • agents registry → total + per-runtime health/degraded/down counts
//   • runtime adapters + the OpenClaw source → per-runtime class + health
//   • board tasks (24h) → pass-rate + recent spend
//   • tasks.verification (24h) → verification-gate pass-rate
//   • governance budgets → count + paused
// The per-runtime tile loop is RuntimeId-agnostic (open-set `runtime` strings) and
// the response carries a dormant multi-tenant `tenantId` seam.

import { agents, createDb, listBudgets, listTasks } from '@clawboo/db'
import { isNull } from 'drizzle-orm'
import type { Request, Response } from 'express'

import { getRegistry } from '../lib/agentSource'
import { getDbPath } from '../lib/db'
import { adapterFactoryFor, enabledRuntimeIds } from '../lib/runtimes'

const DAY_MS = 24 * 60 * 60 * 1000

type DepthClass = 'connected-substrate' | 'wrapped-oneshot' | 'native'

interface RuntimeCounts {
  agentCount: number
  healthy: number
  degraded: number
  down: number
}

function parseVerificationStatus(raw: string): string | null {
  try {
    return (JSON.parse(raw) as { status?: string }).status ?? null
  } catch {
    return null
  }
}

export async function fleetSummaryGET(_req: Request, res: Response): Promise<void> {
  try {
    const db = createDb(getDbPath())

    // ── agents: count live (non-archived) rows by runtime + status ──
    const rows = db
      .select({ runtime: agents.runtime, status: agents.status })
      .from(agents)
      .where(isNull(agents.archivedAt))
      .all() as { runtime: string | null; status: string }[]

    const byRuntime = new Map<string, RuntimeCounts>()
    for (const r of rows) {
      const rt = r.runtime ?? 'openclaw'
      const t = byRuntime.get(rt) ?? { agentCount: 0, healthy: 0, degraded: 0, down: 0 }
      t.agentCount++
      if (r.status === 'idle' || r.status === 'running') t.healthy++
      else if (r.status === 'error') t.degraded++
      else t.down++ // sleeping / archived-status / other
      byRuntime.set(rt, t)
    }

    // ── runtime class + health (adapters + the OpenClaw source) ──
    const meta = new Map<string, { runtimeClass: DepthClass; healthOk: boolean | null }>()
    const ocHealth = await getRegistry().source.health()
    meta.set('openclaw', {
      runtimeClass: 'connected-substrate',
      healthOk: ocHealth.connection === 'connected',
    })
    await Promise.all(
      enabledRuntimeIds().map(async (id) => {
        const adapter = adapterFactoryFor(id)({})
        const caps = adapter.capabilities()
        const h = await adapter.health()
        meta.set(id, {
          runtimeClass: (caps.runtimeClass ?? 'wrapped-oneshot') as DepthClass,
          healthOk: h.ok,
        })
      }),
    )

    const runtimes = [...new Set([...byRuntime.keys(), ...meta.keys()])]
      .map((rt) => {
        const counts = byRuntime.get(rt) ?? { agentCount: 0, healthy: 0, degraded: 0, down: 0 }
        const m = meta.get(rt)
        return {
          runtime: rt,
          runtimeClass: m?.runtimeClass ?? ('wrapped-oneshot' as DepthClass),
          healthOk: m?.healthOk ?? null,
          ...counts,
        }
      })
      .sort((a, b) => b.agentCount - a.agentCount || a.runtime.localeCompare(b.runtime))

    // ── board tasks + verification verdicts in the last 24h ──
    const cutoff = Date.now() - DAY_MS
    const recent = listTasks(db, {}).filter((t) => t.updatedAt >= cutoff)
    let done = 0
    let cancelled = 0
    let inProgress = 0
    let spendCents = 0
    let vPass = 0
    let vFail = 0
    let vDebt = 0
    for (const t of recent) {
      if (t.status === 'done') done++
      else if (t.status === 'cancelled') cancelled++
      else if (t.status === 'in_progress' || t.status === 'in_review') inProgress++
      spendCents += Math.round((t.costUsd ?? 0) * 100)
      if (t.verification) {
        const v = parseVerificationStatus(t.verification)
        if (v === 'pass') vPass++
        else if (v === 'fail') vFail++
        else if (v === 'completed_with_debt') vDebt++
      }
    }
    const terminal = done + cancelled
    const vTotal = vPass + vFail + vDebt

    // ── governance budgets ──
    const allBudgets = listBudgets(db, {})

    res.json({
      generatedAt: Date.now(),
      tenantId: null, // dormant multi-tenant seam
      totalAgents: rows.length,
      runtimes,
      tasks24h: {
        total: recent.length,
        done,
        cancelled,
        inProgress,
        passRate: terminal > 0 ? done / terminal : null,
      },
      verification24h: {
        total: vTotal,
        pass: vPass,
        fail: vFail,
        debt: vDebt,
        passRate: vTotal > 0 ? vPass / vTotal : null,
      },
      spend24hUsd: spendCents / 100,
      budgets: {
        count: allBudgets.length,
        paused: allBudgets.filter((b) => b.status === 'paused').length,
      },
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
}
