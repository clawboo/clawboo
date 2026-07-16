// Client for the agent registry-of-record (AgentSource decoupling).
//
// The SPA reads agents/files/sessions through these REST wrappers, which the
// server backs with SQLite (synced from the Gateway server-side). Reads work even
// when the Gateway is down; writes + file I/O throw on a 503 (gateway
// disconnected) so existing try/catch + loading states behave as they did with
// the direct Gateway calls.
//
// NOTE: the two Zustand-coupled helpers (`refreshFleetFromRegistry`,
// `agentRecordToFleetState`) stay in the web app — they hydrate the SPA's fleet
// store and cannot live in a framework-agnostic package.

import type { AgentFileName, AgentRecord, SessionRecord } from '@clawboo/agent-registry'

import { apiFetch } from './config'

export interface AgentListResult {
  defaultId: string
  mainKey: string
  agents: AgentRecord[]
  stale: boolean
  lastSyncedAt: number | null
}

async function jsonOrThrow<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: string }
      detail = body.error ? `: ${body.error}` : ''
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`${what} failed (${res.status})${detail}`)
  }
  return (await res.json()) as T
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

export async function listAgents(opts?: {
  includeArchived?: boolean
  teamId?: string
}): Promise<AgentListResult> {
  const params = new URLSearchParams()
  if (opts?.includeArchived) params.set('includeArchived', 'true')
  if (opts?.teamId) params.set('teamId', opts.teamId)
  const qs = params.toString()
  const res = await apiFetch(`/api/agents${qs ? `?${qs}` : ''}`)
  return jsonOrThrow<AgentListResult>(res, 'List agents')
}

export async function getAgentRecord(id: string): Promise<AgentRecord | null> {
  const res = await apiFetch(`/api/agents/${encodeURIComponent(id)}`)
  if (res.status === 404) return null
  const body = await jsonOrThrow<{ agent: AgentRecord }>(res, 'Get agent')
  return body.agent
}

export interface CreateAgentRequest {
  name: string
  teamId?: string | null
  personalityConfig?: unknown
  execConfig?: unknown
  avatarSeed?: string | null
  files?: Partial<Record<string, string>>
  /**
   * Which AgentSource creates the record. Omit → the server default (`openclaw`).
   * `'clawboo-native'` → the native source; `'claude-code'`/`'codex'`/`'hermes'`
   * → the generic runtime source. The server 400s an unknown id.
   */
  sourceId?: string
}

export async function createAgentRecord(input: CreateAgentRequest): Promise<AgentRecord> {
  const res = await apiFetch('/api/agents', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  })
  const body = await jsonOrThrow<{ agent: AgentRecord }>(res, 'Create agent')
  return body.agent
}

export async function archiveAgentRecord(id: string): Promise<void> {
  const res = await apiFetch(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await jsonOrThrow<{ ok: true }>(res, 'Delete agent')
}

export async function readAgentFile(
  agentId: string,
  name: AgentFileName | string,
): Promise<string> {
  const res = await apiFetch(
    `/api/agents/${encodeURIComponent(agentId)}/files/${encodeURIComponent(name)}`,
  )
  const body = await jsonOrThrow<{ name: string; content: string }>(res, `Read ${name}`)
  return body.content
}

export async function writeAgentFile(
  agentId: string,
  name: AgentFileName | string,
  content: string,
): Promise<void> {
  const res = await apiFetch(
    `/api/agents/${encodeURIComponent(agentId)}/files/${encodeURIComponent(name)}`,
    {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content }),
    },
  )
  await jsonOrThrow<{ name: string; content: string }>(res, `Write ${name}`)
}

/** Change an agent's model via the model route. Native persists to its AgentConfig
 *  `primaryModel`; Hermes persists to its execConfig `{ provider, model }` (routed via
 *  OpenRouter). Other runtimes (Codex / Claude Code / OpenClaw) 404 here. */
export async function setAgentModel(agentId: string, model: string): Promise<void> {
  const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/model`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ model }),
  })
  await jsonOrThrow<{ ok: boolean; model: string }>(res, 'Set model')
}

/** The Boo Zero OVERRIDE (`/api/boo-zero/override`) — the runtime-neutral "make
 *  this agent the universal leader" designation `resolveBooZero` reads FIRST.
 *  `effective` is where the resolution chain currently lands and `tier` names
 *  the rung that produced it: `override`/`native` are DELIBERATE leaders a
 *  writer must not stomp; `openclaw` is the weak Gateway-`main` fallback a
 *  deliberate designation may outrank. Defensive: on any error reports tier
 *  `'native'` (the fail-safe that blocks a promote rather than misfiring one). */
export interface BooZeroOverride {
  overrideAgentId: string | null
  effective: { id: string } | null
  tier: 'override' | 'native' | 'openclaw' | null
}

export async function fetchBooZeroOverride(): Promise<BooZeroOverride> {
  try {
    const res = await apiFetch('/api/boo-zero/override')
    if (!res.ok) return { overrideAgentId: null, effective: null, tier: 'native' }
    const body = (await res.json()) as Partial<BooZeroOverride>
    return {
      overrideAgentId: body.overrideAgentId ?? null,
      effective: body.effective ?? null,
      tier: body.tier ?? null,
    }
  } catch {
    return { overrideAgentId: null, effective: null, tier: 'native' }
  }
}

/** Set (string) or clear (null) the Boo Zero override. Throws on a rejected write
 *  (unknown/archived agent → 404) so callers can surface it. */
export async function setBooZeroOverride(agentId: string | null): Promise<void> {
  const res = await apiFetch('/api/boo-zero/override', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ agentId }),
  })
  await jsonOrThrow<{ ok: boolean }>(res, 'Set Boo Zero override')
}

export async function listAgentSessions(agentId: string): Promise<SessionRecord[]> {
  const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/sessions`)
  const body = await jsonOrThrow<{ sessions: SessionRecord[] }>(res, 'List sessions')
  return body.sessions
}

/** Browser-fallback sync: push a Gateway agent snapshot to the server so SQLite
 *  stays warm even if the server's own Gateway connection is degraded. */
export async function pushAgentSync(payload: {
  defaultId: string
  mainKey: string
  scope?: string
  agents: Array<{ id: string; name?: string; identity?: Record<string, unknown> }>
}): Promise<void> {
  await apiFetch('/api/agents/sync', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  }).catch(() => {})
}

/** The server's AgentSource connection state. `connection` reflects the OpenClaw
 *  operator connection (the registry's `.source` is the OpenClawAgentSource) — a
 *  thin client with no browser Gateway WS reads this to know whether OpenClaw is
 *  reachable server-side. Defensive: reports disconnected on any error. */
export interface RegistryHealth {
  ok: boolean
  connection: 'connected' | 'connecting' | 'reconnecting' | 'disconnected'
  lastSyncedAt: number | null
}

export async function fetchRegistryHealth(): Promise<RegistryHealth> {
  try {
    const res = await apiFetch('/api/agents/registry/health')
    if (!res.ok) return { ok: false, connection: 'disconnected', lastSyncedAt: null }
    const body = (await res.json()) as Partial<RegistryHealth>
    return {
      ok: body.ok === true,
      connection: body.connection ?? 'disconnected',
      lastSyncedAt: body.lastSyncedAt ?? null,
    }
  } catch {
    return { ok: false, connection: 'disconnected', lastSyncedAt: null }
  }
}
