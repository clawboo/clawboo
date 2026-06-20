// Browser client for the agent registry-of-record (AgentSource decoupling).
//
// The SPA no longer reads agents/files/sessions from the Gateway directly — it
// reads through these REST wrappers, which the server backs with SQLite (synced
// from the Gateway server-side). Reads work even when the Gateway is down; writes
// + file I/O throw on a 503 (gateway disconnected) so existing try/catch + loading
// states behave as they did with the direct Gateway calls.

import type { AgentFileName, AgentRecord, SessionRecord } from '@clawboo/agent-registry'
import { useFleetStore, type AgentState } from '@/stores/fleet'

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
  const res = await fetch(`/api/agents${qs ? `?${qs}` : ''}`)
  return jsonOrThrow<AgentListResult>(res, 'List agents')
}

export async function getAgentRecord(id: string): Promise<AgentRecord | null> {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}`)
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
}

export async function createAgentRecord(input: CreateAgentRequest): Promise<AgentRecord> {
  const res = await fetch('/api/agents', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  })
  const body = await jsonOrThrow<{ agent: AgentRecord }>(res, 'Create agent')
  return body.agent
}

export async function archiveAgentRecord(id: string): Promise<void> {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await jsonOrThrow<{ ok: true }>(res, 'Delete agent')
}

export async function readAgentFile(
  agentId: string,
  name: AgentFileName | string,
): Promise<string> {
  const res = await fetch(
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
  const res = await fetch(
    `/api/agents/${encodeURIComponent(agentId)}/files/${encodeURIComponent(name)}`,
    {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content }),
    },
  )
  await jsonOrThrow<{ name: string; content: string }>(res, `Write ${name}`)
}

export async function listAgentSessions(agentId: string): Promise<SessionRecord[]> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/sessions`)
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
  await fetch('/api/agents/sync', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  }).catch(() => {})
}

/** List the registry + hydrate the fleet store, merging live store state
 *  (status/model/runId/streamingText/lastSeenAt are event-driven) so a refresh
 *  never clobbers a running agent. Returns the agent count. Shared by the
 *  summary-refresh path + every "refresh after creating a Boo" handler. */
export async function refreshFleetFromRegistry(): Promise<number> {
  const { agents: records } = await listAgents()
  const existing = new Map(useFleetStore.getState().agents.map((a) => [a.id, a]))
  useFleetStore.getState().hydrateAgents(
    records.map((r) => {
      const base = agentRecordToFleetState(r)
      const prev = existing.get(r.id)
      return prev
        ? {
            ...base,
            status: prev.status,
            model: prev.model,
            streamingText: prev.streamingText,
            runId: prev.runId,
            lastSeenAt: prev.lastSeenAt,
          }
        : base
    }),
  )
  return records.length
}

/** Map a registry AgentRecord to a fresh fleet AgentState (base fields only —
 *  callers overlay per-agent model + Boo-Zero display-name overrides as before). */
export function agentRecordToFleetState(record: AgentRecord): AgentState {
  return {
    id: record.id,
    name: record.displayName,
    status: 'idle',
    sessionKey: record.sessionKey,
    model: null,
    createdAt: record.createdAt ?? null,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: record.teamId,
    execConfig: (record.execConfig as { execAsk: string } | null) ?? null,
  }
}
