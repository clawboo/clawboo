// Web-only glue over the framework-agnostic agent registry client.
//
// The pure REST wrappers (list/get/create/archive/files/sessions/sync) moved to
// `@clawboo/control-client` — import them from there. These two helpers stay in
// the web app because they hydrate the SPA's Zustand fleet store, which a
// framework-agnostic package can't own.

import type { AgentRecord } from '@clawboo/agent-registry'
import { listAgents } from '@clawboo/control-client'

import { useBooZeroStore, identifyBooZero } from '@/stores/booZero'
import { useFleetStore, type AgentState } from '@/stores/fleet'

/** List the registry + hydrate the fleet store, merging live store state
 *  (status/model/runId/streamingText/lastSeenAt are event-driven) so a refresh
 *  never clobbers a running agent. Returns the agent count. Shared by the
 *  summary-refresh path + every "refresh after creating a Boo" handler.
 *
 *  ALSO identifies Boo Zero from the registry `defaultId` — which the server
 *  resolves as the runtime-NEUTRAL `resolveBooZero(db)` (override → native →
 *  OpenClaw), the same value `booZeroForTeam` uses to pick the team leader. This
 *  is the ONE identification point for NATIVE mode (the Gateway path identifies
 *  in `hydrateFleetFromClient`); it's idempotent + authoritative in both, so a
 *  native-first install correctly points at the teamless native Boo Zero instead
 *  of a leftover OpenClaw agent. */
export async function refreshFleetFromRegistry(): Promise<number> {
  const { agents: records, defaultId } = await listAgents()
  const existing = new Map(useFleetStore.getState().agents.map((a) => [a.id, a]))
  useFleetStore.getState().hydrateAgents(
    records.map((r) => {
      const base = agentRecordToFleetState(r)
      const prev = existing.get(r.id)
      return prev
        ? {
            ...base,
            status: prev.status,
            // OpenClaw model is event-driven (preserve it); a native agent's model is
            // authoritative from its AgentConfig (record.model = base.model), so take
            // the fresh value so a server-side change (onboarding / another client) shows.
            model: r.runtime === 'clawboo-native' ? base.model : prev.model,
            streamingText: prev.streamingText,
            runId: prev.runId,
            lastSeenAt: prev.lastSeenAt,
          }
        : base
    }),
  )
  useBooZeroStore.getState().setBooZeroAgentId(identifyBooZero(records, defaultId || undefined))
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
    // Native agents surface their AgentConfig model; OpenClaw's is event-driven (null here).
    model: record.model ?? null,
    createdAt: record.createdAt ?? null,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: record.teamId,
    runtime: record.runtime ?? null,
    execConfig: (record.execConfig as { execAsk: string } | null) ?? null,
  }
}
