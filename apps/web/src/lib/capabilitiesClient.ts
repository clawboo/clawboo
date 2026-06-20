// Browser client for the unified capability inventory (GET /api/capabilities +
// POST /api/capabilities/:action). The SAME stream feeds BOTH the Ghost Graph and
// the Capabilities dashboard — they call `fetchCapabilities` and never diverge.
// Defensive (never throws; an unreachable server → empty view), mirroring
// memoryClient. CapabilityRecord types come straight from the browser-safe
// @clawboo/capability-registry package.

import type {
  CapabilityInstallSpec,
  CapabilityRecord,
  SourceReadStatus,
} from '@clawboo/capability-registry'

export type { CapabilityRecord, SourceReadStatus } from '@clawboo/capability-registry'

export interface CapabilitiesView {
  records: CapabilityRecord[]
  sources: SourceReadStatus[]
  /** False when the fetch FAILED entirely (network / non-2xx) — lets a consumer
   *  distinguish "the inventory is genuinely empty" from "the fetch failed".
   *  Defaults true; existing callers can ignore it. */
  ok: boolean
}

export interface CapabilityFilter {
  runtime?: string
  kind?: string
  scope?: string
  agentId?: string
}

export async function fetchCapabilities(filter: CapabilityFilter = {}): Promise<CapabilitiesView> {
  const qs = new URLSearchParams()
  if (filter.runtime) qs.set('runtime', filter.runtime)
  if (filter.kind) qs.set('kind', filter.kind)
  if (filter.scope) qs.set('scope', filter.scope)
  if (filter.agentId) qs.set('agentId', filter.agentId)
  const url = qs.toString() ? `/api/capabilities?${qs}` : '/api/capabilities'
  try {
    const res = await fetch(url)
    if (!res.ok) return { records: [], sources: [], ok: false }
    const body = (await res.json()) as Partial<CapabilitiesView>
    return { records: body.records ?? [], sources: body.sources ?? [], ok: true }
  } catch {
    return { records: [], sources: [], ok: false }
  }
}

export interface CapabilityActionResult {
  ok: boolean
  error?: string
  manageability?: string
  record?: CapabilityRecord | null
}

async function postAction(action: string, body: unknown): Promise<CapabilityActionResult> {
  try {
    const res = await fetch(`/api/capabilities/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        error: typeof data['error'] === 'string' ? data['error'] : `HTTP ${res.status}`,
        manageability:
          typeof data['manageability'] === 'string' ? data['manageability'] : undefined,
      }
    }
    return { ok: true, record: (data['record'] as CapabilityRecord | null) ?? null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function installCapability(spec: CapabilityInstallSpec): Promise<CapabilityActionResult> {
  return postAction('install', { spec })
}

export function enableCapability(id: string): Promise<CapabilityActionResult> {
  return postAction('enable', { id })
}

export function disableCapability(id: string): Promise<CapabilityActionResult> {
  return postAction('disable', { id })
}

/** Agent-scoped capabilities grouped by agentId — the Ghost Graph node source. */
export function groupAgentCapabilities(
  records: CapabilityRecord[],
): Map<string, CapabilityRecord[]> {
  const map = new Map<string, CapabilityRecord[]>()
  for (const r of records) {
    if (r.scope !== 'agent' || !r.agentId) continue
    const arr = map.get(r.agentId) ?? []
    arr.push(r)
    map.set(r.agentId, arr)
  }
  return map
}
