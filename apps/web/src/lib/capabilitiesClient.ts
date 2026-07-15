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

/**
 * Per-agent capabilities for the Ghost Graph nodes, keyed by agentId.
 *
 * "Inherit-if-empty": an agent shows its OWN agent-scoped capabilities; an agent
 * that has NONE inherits its runtime's shared (`global`) capabilities. This is
 * what surfaces codex / OpenClaw / a not-yet-run hermes agent's attached MCP +
 * built-ins (their adapters emit runtime-uniform caps once, as `global`), while
 * native agents — which already emit their own per-agent caps — stay uncluttered
 * (they never inherit the shared broker built-ins).
 *
 * `agentRuntimes` maps each agent id → its runtime, so an empty agent knows which
 * runtime's global caps to inherit. Agents absent from the map are ignored.
 */
export function groupAgentCapabilities(
  records: CapabilityRecord[],
  agentRuntimes: Map<string, string | null>,
): Map<string, CapabilityRecord[]> {
  const agentScoped = new Map<string, CapabilityRecord[]>()
  const globalByRuntime = new Map<string, CapabilityRecord[]>()
  for (const r of records) {
    if (r.scope === 'agent' && r.agentId) {
      const arr = agentScoped.get(r.agentId) ?? []
      arr.push(r)
      agentScoped.set(r.agentId, arr)
    } else if (r.scope === 'global' && r.runtime) {
      const arr = globalByRuntime.get(r.runtime) ?? []
      arr.push(r)
      globalByRuntime.set(r.runtime, arr)
    }
  }
  const out = new Map<string, CapabilityRecord[]>()
  for (const [agentId, runtime] of agentRuntimes) {
    const own = agentScoped.get(agentId)
    if (own && own.length > 0) {
      out.set(agentId, own)
    } else {
      const inherited = runtime ? globalByRuntime.get(runtime) : undefined
      if (inherited && inherited.length > 0) out.set(agentId, inherited)
    }
  }
  return out
}
