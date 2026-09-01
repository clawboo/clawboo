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
    noteUserStop(sessionKey)
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

// ─── User-stop signal ────────────────────────────────────────────────────────
//
// WHO NEEDS THIS. The Gateway event path commits whatever prose was on screen
// when a run ends without re-carrying its text, so the reply the operator
// watched is not deleted. A run the operator STOPPED is the one case where that
// is wrong: they asked for the partial to go away, and a delta landing between
// the Stop and the `aborted` terminal would otherwise repopulate the card and
// get it persisted. The native path has the same guard as an explicit
// `userAborted` flag; the Gateway path has no such variable to read, so the
// intent is recorded here instead.

const stops = new Map<string, number>()

/** How long a Stop suppresses the recovery belt. Longer than any terminal lag. */
const STOP_TTL_MS = 10_000

function noteUserStop(sessionKey: string): void {
  stops.set(sessionKey, Date.now())
}

/** Whether the operator stopped this session moments ago. */
export function userStoppedRecently(sessionKey: string, now = Date.now()): boolean {
  const at = stops.get(sessionKey)
  if (at === undefined) return false
  if (now - at > STOP_TTL_MS) {
    stops.delete(sessionKey)
    return false
  }
  return true
}
