// Browser client for the unified capability inventory (GET /api/capabilities +
// POST /api/capabilities/:action). The SAME stream feeds BOTH the Ghost Graph and
// the Capabilities dashboard — they call `fetchCapabilities` and never diverge.
// Defensive (never throws; an unreachable server → empty view), mirroring
// memoryClient. CapabilityRecord types come straight from the browser-safe
// @clawboo/capability-registry package.

import { apiFetch } from '@clawboo/control-client'
import { parseCapabilityId } from '@clawboo/capability-registry'
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
    const res = await apiFetch(url)
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
    const res = await apiFetch(`/api/capabilities/${action}`, {
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
/**
 * Whether this record came from clawboo's OWN outbound connector source.
 *
 * Read off the id rather than off `source`: several runtimes stamp
 * `origin: 'mcp-connector'` on rows describing servers THEY attach, and those
 * are runtime-scoped facts that must keep obeying ordinary inheritance. Only the
 * `connector` source id means clawboo is holding the connection itself.
 */
function isConnectorSourced(record: CapabilityRecord): boolean {
  return parseCapabilityId(record.id)?.sourceId === 'connector'
}

export function groupAgentCapabilities(
  records: CapabilityRecord[],
  agentRuntimes: Map<string, string | null>,
): Map<string, CapabilityRecord[]> {
  const agentScoped = new Map<string, CapabilityRecord[]>()
  const globalByRuntime = new Map<string, CapabilityRecord[]>()
  // A GLOBAL CONNECTOR RECORD IS DROPPED HERE, deliberately. It says a connector
  // exists and is running, which is a fact about the install rather than about
  // any agent, and no agent may be drawn holding it on that basis alone. The
  // agent-scoped record the grant projection emits is what puts one on a ring.
  for (const r of records) {
    if (r.scope === 'agent' && r.agentId) {
      const arr = agentScoped.get(r.agentId) ?? []
      arr.push(r)
      agentScoped.set(r.agentId, arr)
    } else if (r.scope === 'global' && isConnectorSourced(r)) {
      continue
    } else if (r.scope === 'global' && r.runtime) {
      const arr = globalByRuntime.get(r.runtime) ?? []
      arr.push(r)
      globalByRuntime.set(r.runtime, arr)
    }
  }
  const out = new Map<string, CapabilityRecord[]>()
  for (const [agentId, runtime] of agentRuntimes) {
    const own = agentScoped.get(agentId) ?? []
    // SYNTHETIC records are excluded from the "does this agent have its own
    // capabilities" test. A grantee's twin tile is agent-scoped, so counting it
    // would flip inheritance off wholesale and the agent would lose every skill
    // and connector it was showing a second earlier. The twin is still
    // rendered. It is just not evidence of a real per-agent inventory.
    const ownReal = own.filter((r) => !r.synthetic)
    const inherited = (runtime ? globalByRuntime.get(runtime) : undefined) ?? []
    // A CONNECTOR IS NOT INHERITED. It used to be, on the reasoning that clawboo
    // owns the process and every agent reaches it through the same broker, so a
    // connector record is global by construction. That was true while connecting
    // also minted a fleet-wide grant: every agent really could call it, and
    // drawing it on every ring was honest.
    //
    // It is no longer true. Connecting makes a connector available and gives it
    // to nobody; an agent reaches it only through a grant, and the grant
    // projection emits an AGENT-SCOPED record for exactly those. So the
    // agent-scoped records are now the whole answer, and fanning the global one
    // across the fleet would draw an edge for access the agent does not have,
    // which is the one thing this picture must never do.
    if (ownReal.length > 0) {
      out.set(agentId, own)
    } else if (inherited.length > 0 || own.length > 0) {
      out.set(agentId, [...inherited, ...own])
    }
  }
  return out
}
