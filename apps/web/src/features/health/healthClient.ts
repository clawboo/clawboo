// System Health REST client — a thin, defensive wrapper over /api/health (the boot
// probe surface). All calls return a parsed BootReport or throw a readable error;
// the panel renders loading / error / report states.

import { apiFetch } from '@clawboo/control-client'

export interface BootCheck {
  id: string
  ok: boolean
  message: string
  detail?: string
  durationMs: number
}

export interface BootReportResolved {
  clawbooHome: string
  dbPath: string
  apiPort: number | null
  stateDir: string
  vaultPresent: boolean
  masterKeyOk: boolean
}

export interface BootConfig {
  logLevel: string
  budgetPosture: string
  budgetHardCapUsdCents: number | null
  budgetWarnSoftPct: number
  otelEnabledByDefault: boolean
  otelConfigured: boolean
  otelActive: boolean
}

export interface BootReport {
  ok: boolean
  startedAt: string
  finishedAt: string
  checks: BootCheck[]
  degraded: string[]
  fatal: string[]
  config: BootConfig
  resolved: BootReportResolved
}

async function parse(res: Response): Promise<BootReport> {
  if (!res.ok) throw new Error(`health check failed (${res.status})`)
  const body = (await res.json()) as BootReport | { status?: unknown }
  // While the server moves its work folders at boot, /api/health answers with
  // that instead of a boot report.
  if ((body as { status?: unknown }).status === 'migrating') {
    throw new Error('Clawboo is moving its work folders. Try again in a moment.')
  }
  return body as BootReport
}

/** GET the latest boot report (computed at boot, cached). */
export async function fetchHealth(): Promise<BootReport> {
  return parse(await apiFetch('/api/health'))
}

/** Recompute the boot report fresh (the "Re-run probe" button). */
export async function recheckHealth(): Promise<BootReport> {
  return parse(await apiFetch('/api/health/recheck', { method: 'POST' }))
}
