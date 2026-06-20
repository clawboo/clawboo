// Event-driven team orchestration — the team-collaboration engine.
//
// It observes every team participant's session through the OpenClaw RuntimeAdapter
// and feeds the normalized lifecycle events to the pure `boardOrchestration`
// core, which DERIVES board tasks from structured delegations, ROUND-TRIPS their
// results to the board, and REFLECTS completed tasks back to the leader. Board
// mutations feed the projection store (`stores/board.ts`); delivery is routed
// through a non-destructive nudge-queue so a message never interrupts a busy run.
//
// Driven only while `enabled` is true — gated on a live Gateway connection +
// completed history hydration (so hydrated history isn't replayed as new work).

import { useEffect, useRef } from 'react'

import { OpenClawAdapter } from '@clawboo/adapter-openclaw'
import { compactToolResultMarkdown } from '@clawboo/compaction'
import type { RunHandle, RuntimeAdapter, RuntimeEvent } from '@clawboo/executor'
import type { GatewayClient } from '@clawboo/gateway-client'
import type { TranscriptEntry } from '@clawboo/protocol'

import type { AgentState } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'
import { useBoardStore } from '@/stores/board'
import { agentIdFromSessionKey } from '@/lib/sessionUtils'
import { boardClient } from '@/lib/boardClient'
import { createNudgeQueue } from '@/lib/nudgeQueue'
import { createObsMirror, toMirrorEvent } from '@/lib/obsMirror'
import { nextSeq } from '@/lib/sequenceKey'

import {
  createBoardOrchestrator,
  type DelegationSignal,
  type KnownAgent,
} from './boardOrchestration'

// Orchestrator-boundary caps + approval plumbing.
const DEFAULT_MAX_FANOUT = 8
// Client-safe risk heuristic: only obviously destructive/external delegations are
// gated on leader approval (so routine team delegation isn't blocked on a human).
const RISKY_DELEGATION_RE =
  /\b(delete|destroy|drop\s+table|deploy|publish|release|rm\s+-rf|prod(uction)?|secret|credential|api[_-]?key|force[_-]?push)\b/i

type DelegationResolution = 'allow_once' | 'allow_always' | 'deny' | 'expired' | 'timeout'

/** Surface a risky delegation on the leader's approval queue (server reuses the
 *  existing tool_call_approvals handshake). Fails CLOSED on a transport error: the whole point of the gate
 *  is to require human approval for a destructive/external delegation, so an
 *  unreachable approval endpoint must NOT auto-approve it. We map the failure to
 *  `timeout` (a non-approving resolution `spawn` already treats as a skip + a
 *  reflection to the delegator), never `allow_once`. (Only RISKY delegations reach
 *  this; routine team delegation never calls it, so the strictness can't deadlock
 *  ordinary work.) */
async function requestDelegationApprovalRest(input: {
  leaderAgentId: string
  targetAgentName: string
  task: string
}): Promise<DelegationResolution> {
  try {
    const r = await fetch('/api/governance/delegation-approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leaderAgentId: input.leaderAgentId,
        kind: 'code',
        targetAgentName: input.targetAgentName,
        task: input.task,
      }),
    })
    if (!r.ok) return 'timeout'
    const body = (await r.json()) as { resolution?: DelegationResolution }
    return body.resolution ?? 'timeout'
  } catch {
    return 'timeout'
  }
}

export interface UseBoardOrchestrationParams {
  teamId: string
  teamAgents: AgentState[]
  booZeroAgent?: AgentState | null
  client: GatewayClient | null
  /** agentId → team-scoped sessionKey for every participant. */
  teamSessionKeys: Map<string, string>
  /** Gate: connected and history hydrated. */
  enabled: boolean
  /** Monotonic Stop counter — bumps the orchestrator's stop generation. */
  stopSignal: number
}

/** A visible `[Task Update]` narration entry appended to the merged team chat. */
function makeNarrationEntry(sessionKey: string, text: string): TranscriptEntry {
  return {
    entryId: crypto.randomUUID(),
    runId: null,
    sessionKey,
    kind: 'meta',
    role: 'system',
    text,
    source: 'local-send',
    timestampMs: Date.now(),
    sequenceKey: nextSeq(),
    confirmed: true,
    fingerprint: crypto.randomUUID(),
  }
}

export function useBoardOrchestration(params: UseBoardOrchestrationParams): void {
  const { teamId, enabled, client, stopSignal } = params

  // Latest roster / session map / leader, read by the observer without
  // re-subscribing. The leader (Boo Zero, fallback first member) is the reduce
  // point reflections are delivered to.
  const participantsRef = useRef<KnownAgent[]>([])
  participantsRef.current = (
    params.booZeroAgent ? [...params.teamAgents, params.booZeroAgent] : params.teamAgents
  ).map((a) => ({ id: a.id, name: a.name }))
  const sessionKeysRef = useRef<Map<string, string>>(params.teamSessionKeys)
  sessionKeysRef.current = params.teamSessionKeys
  const leaderIdRef = useRef<string | null>(null)
  leaderIdRef.current = params.booZeroAgent?.id ?? params.teamAgents[0]?.id ?? null

  // Re-subscribe only when the participant SET changes — NOT on every fleet
  // status patch (which reallocates the teamAgents / teamSessionKeys refs).
  const signature = participantsRef.current
    .map((a) => a.id)
    .sort()
    .join('|')

  // Stop generation — bumped on Stop so in-flight work bails at its next
  // checkpoint, without tearing down the (continuous) observers.
  const stopGenRef = useRef(0)
  useEffect(() => {
    stopGenRef.current += 1
  }, [stopSignal])

  useEffect(() => {
    if (!enabled || !client) return
    const adapter: RuntimeAdapter = new OpenClawAdapter(client)
    // onWedge: if a session's turn boundary is never observed, abort its
    // (apparently- or genuinely-) still-running run BEFORE the queue force-idles +
    // flushes a queued send — so a long silent tool-call can't be joined by a
    // SECOND concurrent run on the same session.
    const nudge = createNudgeQueue({
      onWedge: (sessionKey) =>
        void adapter.abort({ adapterId: 'openclaw', sessionKey, runId: null }),
    })
    const orchestrator = createBoardOrchestrator({
      teamId,
      board: boardClient,
      known: () => participantsRef.current,
      leaderAgentId: () => leaderIdRef.current,
      sessionKeyForAgent: (id) => sessionKeysRef.current.get(id) ?? null,
      agentIdForSession: (sk) => agentIdFromSessionKey(sk),
      // Route every delivery through the nudge-queue: idle → send now, busy →
      // queue for the turn boundary (never interrupts an in-flight run).
      deliver: (targetSessionKey, targetAgentId, task) =>
        nudge.deliver(targetSessionKey, async () => {
          await adapter.start(
            { teamId },
            {
              agentId: targetAgentId,
              sessionKey: targetSessionKey,
              message: task,
              childToolBlocklist: ['sessions_send'],
            },
          )
        }),
      stopGen: () => stopGenRef.current,
      // Client-derived change-feed → the read-only projection store.
      onBoardChange: (change) => useBoardStore.getState().applyChange(teamId, change),
      // Visible board→chat narration.
      narrate: (sessionKey, text) =>
        useChatStore
          .getState()
          .appendTranscript(sessionKey, [makeNarrationEntry(sessionKey, text)]),
      // Compact a child's report-up summary before it's recorded/relayed.
      // Pass-through-safe + failure-preserving.
      compact: (text: string) => compactToolResultMarkdown(text).text,
      // Governance: fan-out cap + approval plumbing through delegation.
      caps: { maxFanout: DEFAULT_MAX_FANOUT },
      isRiskyDelegation: (sig: DelegationSignal) => RISKY_DELEGATION_RE.test(sig.task),
      requestDelegationApproval: (input: {
        leaderAgentId: string
        targetAgentName: string
        task: string
      }) => requestDelegationApprovalRest(input),
    })

    let cancelled = false
    const stops: Array<() => void> = []

    // Idle watchdog: periodically fail any delegate that's gone silent past the
    // window so the leader is never "left standing" (the in-chat analog of the
    // routine dispatcher's timeout). Cheap — a no-op when nothing is overdue.
    const sweepTimer = setInterval(() => void orchestrator.sweepStaleSessions(), 30_000)

    // Mirror per-tool runtime detail (tool calls / results / errors) into the
    // durable obs log so the activity terminal shows the OpenClaw path too. Board
    // lifecycle is already emitted server-side, so it is NOT mirrored here.
    const obsMirror = createObsMirror()

    // The per-session consumer loop: drain the (already-subscribed) event stream.
    const consume = (sessionKey: string, iterator: AsyncIterator<RuntimeEvent>): void => {
      void (async () => {
        while (!cancelled) {
          let result: IteratorResult<RuntimeEvent>
          try {
            result = await iterator.next()
          } catch {
            break
          }
          if (cancelled || result.done) break
          const event = result.value
          // Mirror BEFORE onEvent — a fatal error completes (and unmaps) the
          // session, so the task correlation must be read while it still holds.
          const mirror = toMirrorEvent(event, {
            teamId,
            agentId: agentIdFromSessionKey(sessionKey),
            taskId: orchestrator.taskForSession(sessionKey),
            nowMs: Date.now(),
          })
          if (mirror) obsMirror.push(mirror)
          // Track turn boundaries for the nudge-queue: a terminal event means
          // the session is idle (flush queued deliveries); anything else means
          // it's mid-run (busy).
          if (event.kind === 'done' || event.kind === 'error') nudge.markIdle(sessionKey)
          else nudge.markBusy(sessionKey)
          try {
            await orchestrator.onEvent(sessionKey, event)
          } catch {
            // a single bad event must not kill the observer
          }
        }
        // The observer ended while NOT tearing down (connection drop / stream
        // error) — fail any delegation still in flight on this session so the
        // leader learns instead of waiting on a dead observer.
        if (!cancelled) void orchestrator.onSessionClosed(sessionKey)
      })()
    }

    // SUBSCRIBE all sessions first (adapter.events subscribes eagerly + buffers),
    // then snapshot durable in-flight work via resume() BEFORE starting the
    // consumers. This closes the race where a completion that lands during
    // resume()'s REST fetch would otherwise be observed by an early consumer with
    // the session→task mapping not yet attached (a dropped completion + a false
    // 8-min timeout). Buffered events are dispatched once consumers start, after
    // the mapping is in place.
    const pending: Array<{ sessionKey: string; iterator: AsyncIterator<RuntimeEvent> }> = []
    for (const [, sessionKey] of sessionKeysRef.current) {
      const run: RunHandle = { adapterId: 'openclaw', sessionKey, runId: null }
      const iterator = adapter.events(run)[Symbol.asyncIterator]()
      stops.push(() => void iterator.return?.())
      pending.push({ sessionKey, iterator })
    }
    void (async () => {
      // Durable resume: re-attach to in-flight tasks + fire any plan step left
      // ready, so a refresh / team re-open doesn't strand work mid-plan.
      await orchestrator.resume()
      if (cancelled) return
      for (const { sessionKey, iterator } of pending) consume(sessionKey, iterator)
    })()

    return () => {
      cancelled = true
      clearInterval(sweepTimer)
      obsMirror.flush()
      obsMirror.reset()
      for (const stop of stops) stop()
      orchestrator.reset()
      // drain (not reset): flush a reflection queued for a still-busy session (the
      // orchestrator's reset() flushed it into this queue) before disposing the
      // adapter — its turn boundary may never arrive post-teardown.
      nudge.drain()
      void adapter.dispose?.()
    }
  }, [enabled, client, teamId, signature])
}
