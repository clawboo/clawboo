// stopChatOperation — "pull the plug" for the chat composer's Stop button.
//
// Two layers, in this order:
//   1. Optimistic local teardown — patches `useFleetStore` + `useChatStore`
//      immediately so the UI flips to idle within one render. Without this
//      step the user would stare at a streaming card while the abort RPC
//      round-trips.
//   2. Best-effort `chat.abort` RPC(s) — actually tells the Gateway to stop
//      generating tokens. The Gateway then emits `chat:aborted` events
//      which the existing event pipeline ([events/policy/work.ts:72]) maps
//      to the SAME idle patch as step 1, so this is idempotent.
//
// For group chat there's a third concern: the orchestration hook's
// in-memory state (debounce timer, relay cooldowns, wake-in-flight set,
// team-chat overrides). Those don't live in stores, so they need explicit
// clears here. The debounce timer specifically is cleared via the
// `stopSignal` counter the caller bumps before invoking this — see
// `useTeamOrchestration`.

import type { GatewayClient } from '@clawboo/gateway-client'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'
import { clearTeamRelayState } from '@/features/group-chat/contextRelay'
import { clearAllTeamChatOverridesForAgent } from '@/lib/sessionUtils'
import { clearWakeInFlight } from '@/features/group-chat/groupChatSendOperation'

// ── Single agent ─────────────────────────────────────────────────────────────

export interface StopAgentRunParams {
  client: GatewayClient | null
  agentId: string
  sessionKey: string | null
  runId: string | null
}

/**
 * Stop a single agent's in-flight run. Used by `ChatPanel`'s Stop button.
 * Tolerates `null` for `client`/`sessionKey`/`runId` — the local cleanup
 * still runs (the abort RPC is skipped when any of them is null).
 */
export async function stopAgentRun(params: StopAgentRunParams): Promise<void> {
  const { client, agentId, sessionKey, runId } = params

  // 1. Optimistic local teardown — flip status, clear runId, clear streaming.
  useFleetStore.getState().patchAgent(agentId, {
    status: 'idle',
    runId: null,
    streamText: null,
  })
  if (sessionKey) {
    useChatStore.getState().setStreamingText(sessionKey, null)
  }

  // 2. Best-effort server-side abort. The Gateway responds with
  //    `{ ok, abortedRunId, status }`; `status: 'no-active-run'` is a
  //    benign no-op (the run already finished). We don't surface errors —
  //    local state is already correct.
  if (client && sessionKey && runId) {
    try {
      await client.chat.abort(sessionKey, runId)
    } catch {
      // Disconnected, race, or Gateway transient error — local cleanup
      // already happened, so silently swallow.
    }
  }
}

// ── Whole team ───────────────────────────────────────────────────────────────

export interface StopAllInTeamParams {
  client: GatewayClient | null
  teamId: string
  /**
   * Effective participants = team members + Boo Zero (when present), deduped
   * by id. Same shape `GroupChatPanel` already computes in `participants`.
   */
  participants: AgentState[]
  /** agentId → team-scoped sessionKey, same map `GroupChatPanel` builds. */
  teamSessionKeys: Map<string, string>
}

/**
 * Abort every running run on the team AND wipe orchestration in-flight
 * state so no follow-up delegation / relay fires after Stop. The caller
 * (`GroupChatPanel`) is expected to ALSO bump its `stopSignal` counter
 * before calling this — that clears `useTeamOrchestration`'s debounce
 * timer + bookkeeping refs which live inside the hook and aren't
 * reachable from here.
 */
export async function stopAllInTeam(params: StopAllInTeamParams): Promise<void> {
  const { client, teamId, participants, teamSessionKeys } = params

  // Target every participant that's currently working — `running` covers the
  // common case. `sleeping` agents aren't generating, so no abort needed.
  const runningAgents = participants.filter((a) => a.status === 'running')

  // 1. Optimistic local teardown for each running agent.
  for (const agent of runningAgents) {
    useFleetStore.getState().patchAgent(agent.id, {
      status: 'idle',
      runId: null,
      streamText: null,
    })
    const sk = teamSessionKeys.get(agent.id)
    if (sk) useChatStore.getState().setStreamingText(sk, null)
  }

  // 2. Clear orchestration in-memory state — these don't live in stores so
  //    the `chat:aborted` events from the Gateway won't clean them up.
  clearTeamRelayState(teamId)
  clearWakeInFlight(teamId)
  for (const agent of runningAgents) {
    clearAllTeamChatOverridesForAgent(agent.id)
  }

  // 3. Best-effort server-side aborts in parallel. We use the team-scoped
  //    sessionKey for each agent — group-chat runs are scoped to that
  //    session, so aborting on the 1:1 sessionKey would miss the actual
  //    in-flight run.
  if (!client) return
  const aborts: Promise<unknown>[] = []
  for (const agent of runningAgents) {
    const sk = teamSessionKeys.get(agent.id)
    if (!sk || !agent.runId) continue
    aborts.push(client.chat.abort(sk, agent.runId).catch(() => undefined))
  }
  await Promise.allSettled(aborts)
}
