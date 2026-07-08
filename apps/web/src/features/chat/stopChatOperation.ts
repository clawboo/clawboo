// stopChatOperation — "pull the plug" for the 1:1 chat composer's Stop button.
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
//         b. Queued / pending work on the session gets nuked alongside the
//            active run, instead of firing one beat later.
// Both RPCs are idempotent — `status: 'no-active-run'` for already-idle
// sessions is a benign no-op. We `Promise.allSettled` everything so a
// single failure can't block the rest of the teardown.
//
// Team-chat Stop is now server-side (`stopServerTeam` → POST /api/teams/:id/chat/stop);
// the browser-orchestration team stop (`stopAllInTeam`) was retired with the browser
// team engine.

import type { GatewayClient } from '@clawboo/gateway-client'

import { useChatStore } from '@/stores/chat'
import { useFleetStore } from '@/stores/fleet'

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
