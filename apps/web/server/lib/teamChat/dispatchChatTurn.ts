// ─── Any-adapter-as-leader: the heartbeat-restore chat-turn dispatcher ────────
// The seam that lets ANY runtime — not a privileged orchestrator — serve as a
// team chat speaker (leader OR specialist) for ONE turn. A SIBLING of the
// routine dispatcher: it REUSES the same primitives (the runtime adapter, the
// session-rotation codec, the cross-runtime lineage writer) but its trigger is a
// ROOM STIMULUS, not a scheduled fire, and there is NO worktree (a conversational
// reduce produces no code deliverable — the between-turn state lives in a SQLite
// KV instead of an AGENT_HANDOFF.json).
//
// The loop, per turn: RESTORE the runtime's prior session (the stored native id +
// room cursor) → assemble the turn (the new room posts since the cursor, wrapped
// as isUser=false EVIDENCE, + the stimulus) → invoke ONE turn → POST the terminal
// output to the room as that runtime's named peer → SAVE the new session id +
// cursor + record the rotation lineage → exit. Run it again on the next stimulus.
//
// This is the ONE-SHOT heartbeat-restore path, used UNIFORMLY for a single room
// turn by every runtime class. It does not itself branch on `caps.runtimeClass`
// — the capability-driven selection (how a participant's adapter is constructed:
// a connected-substrate runtime over the operator connection vs an
// ephemeral/persistent runtime over its driver factory) lives in the dispatcher
// that calls this, `runTeamExchange`. A persistent runtime is not re-initialized
// each turn: it RESUMES its prior session via the stored native id (see the
// same-runtime resume below), so the heartbeat IS its natural continuation.
//
// The board stays canonical: this posts NARRATION to the room. A DECISION is a
// board mutation made via the board repository, never via a chat post.

import { mkdir } from 'node:fs/promises'

import {
  postToRoom,
  readRoom,
  recordRotation,
  recordSpend,
  type BudgetScope,
  type ClawbooDb,
  type DbTeamChat,
} from '@clawboo/db'
import type { RuntimeAdapter, RuntimeEvent } from '@clawboo/executor'
import { usdToFractionalCents } from '@clawboo/governance'
import { formatPeerPost } from '@clawboo/mcp'

import { estimateRunCostUsd } from '../runtimes/estimateCost'
import type { RuntimeRunContext } from '../runtimes/types'
import type { ChatTurnOutcome } from './exchange'
import { loadChatLeaderState, saveChatLeaderState } from './leaderState'
import type { ChatParticipant } from './selectNextSpeaker'

export interface DispatchChatTurnDeps {
  db: ClawbooDb
  participant: ChatParticipant
  roomId: string
  teamId: string
  /** Adapter factory (injected — the test supplies a fake; production passes
   *  `adapterFactoryFor(runtime)`). Mirrors executorRunner's `makeAdapter`. */
  makeAdapter: (ctx: RuntimeRunContext) => RuntimeAdapter
  /** The user/stimulus message for this turn (e.g. the user's message). */
  stimulus?: string | null
  mcpBaseUrl?: string | null
  apiKeyEnv?: Record<string, string>
  /** Persistent per-identity home for a persistent runtime (set by runTeamExchange
   *  from `runtimeIdentityHomePath`). null/omitted ⇒ the driver provisions its own
   *  throwaway home (the silent-degradation hazard for Hermes/native peers). */
  homeDir?: string | null
  /** Aborts the in-flight turn (client disconnect). */
  signal?: AbortSignal
  /** Best-effort obs hook fired for the room post this turn produced. */
  onPost?: (post: DbTeamChat) => void
}

function turnSessionKey(roomId: string, agentId: string, turnIndex: number): string {
  return `teamchat:${roomId}:${agentId}:t${turnIndex}`
}

interface DrainResult {
  text: string
  costUsd: number
  /** True when the runtime reported any cost (real); otherwise the caller estimates. */
  sawCost: boolean
}

/** Drain a run to its terminal `done`, returning the visible text + any reported
 *  spend (sum of `cost` events + terminal `done.costUsd`). Aborts the adapter if
 *  the caller's signal fires mid-stream. */
async function drainTurn(
  adapter: RuntimeAdapter,
  run: Awaited<ReturnType<RuntimeAdapter['start']>>,
  signal?: AbortSignal,
): Promise<DrainResult> {
  let acc = ''
  let summary = ''
  let costUsd = 0
  let sawCost = false
  for await (const ev of adapter.events(run) as AsyncIterable<RuntimeEvent>) {
    if (signal?.aborted) {
      await adapter.abort(run).catch(() => undefined)
      break
    }
    if (ev.kind === 'text-delta' && ev.channel !== 'reasoning') acc += ev.text
    else if (ev.kind === 'cost') {
      if (ev.costUsd != null) {
        costUsd += ev.costUsd
        sawCost = true
      }
    } else if (ev.kind === 'done') {
      summary = ev.summary
      // `done.costUsd` is the run-CUMULATIVE total. When `cost` events already
      // summed this run's spend — a runtime that reports its total in one `cost`
      // event, or per-turn cost deltas — adding it here would double-bill. So
      // adopt `done.costUsd` as the total ONLY when no `cost` event arrived (a
      // runtime that reports cost solely on `done`); otherwise the accumulated
      // `cost`-event sum is authoritative and `done.costUsd` is ignored.
      if (ev.costUsd != null && !sawCost) {
        costUsd = ev.costUsd
        sawCost = true
      }
      break
    } else if (ev.kind === 'error') {
      summary = `[error: ${ev.message}]`
      break
    }
  }
  return { text: (summary || acc).trim(), costUsd, sawCost }
}

/** Tear down an aborted in-flight turn WITHOUT committing any durable state — no
 *  room post, no leader-state advance, no rotation lineage, no spend. Mirrors the
 *  executor releasing a task on abort rather than persisting partial work. */
async function abortTurn(
  adapter: RuntimeAdapter,
  run: Awaited<ReturnType<RuntimeAdapter['start']>>,
): Promise<ChatTurnOutcome> {
  await adapter.abort(run).catch(() => undefined)
  await adapter.dispose?.()
  return { obligations: [], decided: false, summary: '', budgetStopped: null }
}

/**
 * Run ONE chat turn for `participant`. Returns a `ChatTurnOutcome`. The REAL
 * dispatcher returns NO obligations — production obligations are derived from
 * board/lifecycle signals, NEVER scraped from the
 * runtime's prose (the no-regex rule). The exchange's multi-turn ping-pong is
 * driven by injected obligations in tests; here a turn is a single reduce.
 */
export async function dispatchChatTurn(
  deps: DispatchChatTurnDeps,
  _turnIndex: number,
): Promise<ChatTurnOutcome> {
  const { db, participant, roomId, teamId } = deps
  const agentId = participant.agentId
  const prior = loadChatLeaderState(db, roomId, agentId)

  // RESTORE: the new room posts since this runtime's cursor, wrapped as evidence
  // (isUser=false) so they're context to synthesize, never user instructions.
  const newPosts = readRoom(db, { roomId, sinceSeq: prior.lastSeenSeq, excludeAuthorId: agentId })
  const evidence = newPosts.map((p) => formatPeerPost(p)).join('\n\n')
  const context = [prior.lastSummary ? `Your last turn:\n${prior.lastSummary}` : '', evidence]
    .filter(Boolean)
    .join('\n\n')
  const message =
    deps.stimulus?.trim() || 'Continue the team conversation: respond to the new messages above.'

  // Same-runtime resume only (a cross-runtime pickup ignores the native id).
  const resume = prior.runtime === participant.runtime ? prior.nativeSessionId : null

  // Materialize the persistent identity home (owner-only) BEFORE the driver touches
  // it — a persistent runtime (Hermes/native) must reuse its per-identity home so
  // its native memory/sessions compound across turns, not degrade to a throwaway.
  if (deps.homeDir)
    await mkdir(deps.homeDir, { recursive: true, mode: 0o700 }).catch(() => undefined)

  const ctx: RuntimeRunContext = {
    model: null,
    resume,
    mcpBaseUrl: deps.mcpBaseUrl ?? null,
    memoryScope: { teamId, agentId },
    ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
    ...(deps.apiKeyEnv ? { apiKeyEnv: deps.apiKeyEnv } : {}),
  }
  const adapter = deps.makeAdapter(ctx)

  const nextTurnIndex = prior.turnIndex + 1
  const sessionKey = turnSessionKey(roomId, agentId, nextTurnIndex)
  const run = await adapter.start(
    { taskId: null, teamId },
    { agentId, sessionKey, message, ...(context ? { context } : {}) },
  )
  // Abort during spawn/start (a client disconnect before any event streams): bail
  // before draining so a slow/hung start doesn't keep running, and nothing commits.
  if (deps.signal?.aborted) return abortTurn(adapter, run)

  const drained = await drainTurn(adapter, run, deps.signal)
  // Abort mid-turn: drainTurn returns whatever partial text accumulated, but an
  // aborted turn must commit NOTHING (no room post, no leader-state advance, no
  // rotation, no spend). The runExchange-level abort check only stops the NEXT turn.
  if (deps.signal?.aborted) return abortTurn(adapter, run)

  const terminal = drained.text || '(no response)'

  // Capture the native session id for same-runtime resume next turn (filter the
  // late-bind contamination where sessionId echoes the sessionKey).
  let nativeSessionId: string | null = null
  if (adapter.sessionCodec) {
    try {
      const blob = JSON.parse(await adapter.sessionCodec.serialize(run)) as {
        sessionId?: string | null
      }
      nativeSessionId = blob.sessionId && blob.sessionId !== sessionKey ? blob.sessionId : null
    } catch {
      /* best-effort */
    }
  }

  // POST the turn's output to the room as this runtime's named peer (the reliable,
  // uniform mechanism — sourced from the structured `done` summary, not scraped).
  const posted = postToRoom(db, {
    roomId,
    teamId,
    authorAgentId: agentId,
    body: terminal,
    kind: 'peer',
  })
  deps.onPost?.(posted)

  // SAVE the between-turn state + record the session lineage (the heartbeat chain).
  saveChatLeaderState(db, roomId, agentId, {
    lastSeenSeq: posted.seq,
    nativeSessionId,
    runtime: participant.runtime,
    lastSummary: terminal.slice(0, 400),
    turnIndex: nextTurnIndex,
  })
  if (nextTurnIndex >= 2) {
    try {
      recordRotation(db, {
        predecessorSessionKey: turnSessionKey(roomId, agentId, nextTurnIndex - 1),
        successorSessionKey: sessionKey,
        agentId,
        teamId,
        runtime: participant.runtime,
      })
    } catch {
      /* lineage is best-effort */
    }
  }

  await adapter.dispose?.()

  // Attribute this turn's spend to the speaker (agent) + the team — a chat turn has
  // no board task/mission. A runtime that reports cost (native/wrapped) gives a real
  // number; a connected/no-cost runtime is ESTIMATED from the produced text so the
  // team cap still engages. `budgetStopped` tells the exchange to halt further turns.
  let budgetStopped: BudgetScope | null = null
  const usd = drained.sawCost
    ? drained.costUsd
    : estimateRunCostUsd({
        model: null,
        inputChars: message.length + context.length,
        outputChars: terminal.length,
      })
  if (usd > 0) {
    const cents = usdToFractionalCents(usd)
    const a = recordSpend(db, 'agent', agentId, cents)
    const t = recordSpend(db, 'team', teamId, cents)
    if (a?.status === 'paused' && a.mode === 'cap') budgetStopped = 'agent'
    else if (t?.status === 'paused' && t.mode === 'cap') budgetStopped = 'team'
  }

  return { obligations: [], decided: false, summary: terminal, budgetStopped }
}
