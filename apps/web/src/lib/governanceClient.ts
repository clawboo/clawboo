// Thin typed wrapper over the governance REST surface (budgets + audit).
// Defensive like `boardClient`: every call resolves to a
// safe value on failure, never throwing. The SPA never imports server packages,
// so the row shapes are mirrored locally here.

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

export type BudgetScope = 'agent' | 'mission' | 'team' | 'tenant'
export type BudgetStatus = 'active' | 'soft_capped' | 'paused'
/** 'cap' = hard cap (auto-pause at 100%); 'warn' = track-and-warn (never pause). */
export type BudgetMode = 'cap' | 'warn'

export interface Budget {
  id: string
  scope: BudgetScope
  scopeId: string
  limitUsdCents: number
  spentUsdCents: number
  status: BudgetStatus
  mode: BudgetMode
  tenantId: string | null
  createdAt: number
  updatedAt: number
}

export type AuditEventType =
  | 'install'
  | 'approval'
  | 'tool_call'
  | 'budget'
  | 'cap_hit'
  | 'verification'
  | 'circuit_break'

export interface AuditRow {
  id: string
  eventType: AuditEventType
  agentId: string | null
  taskId: string | null
  teamId: string | null
  tenantId: string | null
  summary: string
  createdAt: number
}

export interface BudgetsResult {
  budgets: Budget[]
  /** False on a network/non-2xx failure — distinguishes a failed load from a
   *  genuinely-empty budget list so the panel can show an error/retry. */
  ok: boolean
}

/** GET /api/governance/budgets */
export async function listBudgets(): Promise<BudgetsResult> {
  try {
    const r = await fetch('/api/governance/budgets')
    if (!r.ok) return { budgets: [], ok: false }
    const body = (await r.json()) as { budgets?: Budget[] }
    return { budgets: body.budgets ?? [], ok: true }
  } catch {
    return { budgets: [], ok: false }
  }
}

export interface SetBudgetInput {
  scope: BudgetScope
  scopeId: string
  limitUsdCents: number
  /** Posture: 'cap' auto-pauses at 100%, 'warn' only warns. Default 'cap'. */
  mode?: BudgetMode
  tenantId?: string | null
}

/** POST /api/governance/budgets — set/raise a cap (raising above spend un-pauses). */
export async function setBudget(input: SetBudgetInput): Promise<Budget | null> {
  try {
    const r = await fetch('/api/governance/budgets', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    })
    if (!r.ok) return null
    const body = (await r.json()) as { budget?: Budget }
    return body.budget ?? null
  } catch {
    return null
  }
}

export interface ResumeBudgetResult {
  budget: Budget | null
  /** True when the scope was resumed while still at/over its limit — it will
   *  re-pause on the next cost event unless the cap is raised. */
  willRepause: boolean
}

/** POST /api/governance/budgets/:scope/:scopeId/resume — human override / un-pause.
 *  Pass `graceUsdCents` to raise the cap above current spend so progress is possible. */
export async function resumeBudget(
  scope: BudgetScope,
  scopeId: string,
  graceUsdCents?: number,
): Promise<ResumeBudgetResult> {
  try {
    const r = await fetch(
      `/api/governance/budgets/${encodeURIComponent(scope)}/${encodeURIComponent(scopeId)}/resume`,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(graceUsdCents != null ? { graceUsdCents } : {}),
      },
    )
    if (!r.ok) return { budget: null, willRepause: false }
    const body = (await r.json()) as { budget?: Budget; willRepause?: boolean }
    return { budget: body.budget ?? null, willRepause: body.willRepause === true }
  } catch {
    return { budget: null, willRepause: false }
  }
}

export interface AuditFilter {
  agentId?: string
  eventType?: AuditEventType
  since?: number
  limit?: number
}

/** GET /api/governance/audit — the append-only forensic log (filterable). */
export async function listAudit(filter: AuditFilter = {}): Promise<AuditRow[]> {
  try {
    const p = new URLSearchParams()
    if (filter.agentId) p.set('agentId', filter.agentId)
    if (filter.eventType) p.set('eventType', filter.eventType)
    if (filter.since) p.set('since', String(filter.since))
    if (filter.limit) p.set('limit', String(filter.limit))
    const qs = p.toString()
    const r = await fetch(`/api/governance/audit${qs ? `?${qs}` : ''}`)
    if (!r.ok) return []
    const body = (await r.json()) as { audit?: AuditRow[] }
    return body.audit ?? []
  } catch {
    return []
  }
}
