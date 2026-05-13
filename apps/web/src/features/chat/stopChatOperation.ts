// stopChatOperation — "pull the plug" for the chat composer's Stop button.
//
// Three layers, in this order:
//   1. Optimistic local teardown — patches `useFleetStore` + `useChatStore`
//      immediately so the UI flips to idle within one render. Without this
//      step the user would stare at a streaming card while the abort RPC
//      round-trips.
//   2. `chat.abort(sessionKey, runId)` per running agent — the surgical
//      cancel. Tells the Gateway to stop generating tokens on a specific
//      in-flight run. Skipped when `runId` is null (very fast Stop press
//      before the first streaming event populated the runId).
//   3. `sessions.abort(sessionKey)` per session as a backstop — heavier
//      session-level abort. Fires REGARDLESS of whether `runId` was
//      available. Covers two cases that pure `chat.abort` misses:
//         a. `runId` is null at stop time → `chat.abort` is skipped, but
//            the Gateway resolves the active run from the sessionKey.
//         b. Queued / pending work on the session (delegate sends, wake
//            messages) gets nuked alongside the active run, instead of
//            firing one beat later and starting a fresh cascade.
// Both RPCs are idempotent — `status: 'no-active-run'` for already-idle
// sessions is a benign no-op. We `Promise.allSettled` everything so a
// single failure can't block the rest of the teardown.
//
// For group chat there's a fourth concern: the orchestration hook's
// in-memory state (debounce timer, relay cooldowns, wake-in-flight set,
// team-chat overrides). Those don't live in stores, so they need explicit
// clears here. The debounce timer + `lastCountsRef` snapshot + post-stop
// freeze window are cleared via the `stopSignal` counter the caller bumps
// before invoking this — see `useTeamOrchestration`.

import type { GatewayClient } from '@clawboo/gateway-client'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'
import { clearTeamRelayState } from '@/features/group-chat/contextRelay'
import { clearAllTeamChatOverridesForAgent } from '@/lib/sessionUtils'
import { clearWakeInFlight } from '@/features/group-chat/groupChatSendOperation'
import { bumpStopGeneration } from '@/features/group-chat/useTeamOrchestration'

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
  if (!client || !sessionKey) return
  const aborts: Promise<unknown>[] = []
  if (runId) {
    // Surgical: cancel this specific run.
    aborts.push(client.chat.abort(sessionKey, runId).catch(() => undefined))
  }
  // Backstop: heavier session-level abort. Catches the runId-less race
  // (Stop pressed before the first streaming event) AND nukes any queued
  // work on the session.
  aborts.push(client.sessions.abort(sessionKey).catch(() => undefined))
  await Promise.allSettled(aborts)
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

  // 0. Bump the orchestration generation counter FIRST — before any await
  //    yields the microtask queue. Mid-flight delegation/relay IIFEs in
  //    `useTeamOrchestration` will see the new generation at their next
  //    checkpoint and bail before issuing their delayed `chat.send`. The
  //    stop-signal useEffect inside the hook also bumps this, but that
  //    runs after a React commit — bumping here avoids the small race
  //    window where an IIFE could slip through its checkpoint before the
  //    effect lands.
  bumpStopGeneration(teamId)

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
  //
  // Two aborts per agent: surgical `chat.abort` when `runId` is available,
  // PLUS `sessions.abort` as a backstop. The backstop covers (a) the
  // runId-less race where Stop fires before the first streaming event
  // arrived, and (b) queued delegate / wake sends that would otherwise
  // fire after the surgical abort and restart the cascade.
  if (!client) return
  const aborts: Promise<unknown>[] = []
  for (const agent of runningAgents) {
    const sk = teamSessionKeys.get(agent.id)
    if (!sk) continue
    if (agent.runId) {
      aborts.push(client.chat.abort(sk, agent.runId).catch(() => undefined))
    }
    aborts.push(client.sessions.abort(sk).catch(() => undefined))
  }
  await Promise.allSettled(aborts)
}
