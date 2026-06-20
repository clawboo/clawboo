// Defensive client for the fleet-health overview (GET /api/fleet/summary) — a
// read-only aggregation of existing data (agents · per-runtime health · 24h
// task/verification pass-rate · spend · budgets). Never throws; an unreachable
// server resolves to null and the view shows an empty state.

import type { RuntimeClass } from './runtimesClient'

export interface FleetRuntimeTile {
  runtime: string
  runtimeClass: RuntimeClass
  healthOk: boolean | null
  agentCount: number
  healthy: number
  degraded: number
  down: number
}

export interface FleetSummary {
  generatedAt: number
  tenantId: string | null
  totalAgents: number
  runtimes: FleetRuntimeTile[]
  tasks24h: {
    total: number
    done: number
    cancelled: number
    inProgress: number
    passRate: number | null
  }
  verification24h: {
    total: number
    pass: number
    fail: number
    debt: number
    passRate: number | null
  }
  spend24hUsd: number
  budgets: { count: number; paused: number }
}

export async function fetchFleetSummary(): Promise<FleetSummary | null> {
  try {
    const res = await fetch('/api/fleet/summary')
    if (!res.ok) return null
    return (await res.json()) as FleetSummary
  } catch {
    return null
  }
}

export interface FleetIssue {
  runtime?: string | null
  errorClass?: string
  message?: string
  ts?: number
}

/** Recent issues = the last N error events from the obs taxonomy (GET /api/obs/errors). */
export async function fetchRecentIssues(limit = 6): Promise<FleetIssue[]> {
  try {
    const res = await fetch('/api/obs/errors')
    if (!res.ok) return []
    const body = (await res.json()) as { errors?: FleetIssue[] }
    return (body.errors ?? []).slice(0, limit)
  } catch {
    return []
  }
}
