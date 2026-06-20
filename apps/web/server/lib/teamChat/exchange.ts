// ─── Bounded ping-pong exchange coordinator ──────────────────────────────────
// An *exchange* is a bounded sequence of peer turns triggered by ONE stimulus (a
// user message or a board event). Each turn: select-next-speaker → dispatch ONE
// turn → the speaker posts to the room / mutates the board → collect who it
// obliges to speak next → repeat until the per-exchange turn cap OR no pending
// obligation remains. This is the guard that two agents cannot chatter forever
// (OpenClaw's `sessions_send` bounds the same way: `maxPingPongTurns`, default 5).
//
// CRITICAL — narration ≠ truth. Speaker-selection + the turn cap govern NARRATION
// ONLY. A decision still lands as a board mutation (the existing claim/status/
// handoff path); the chat NEVER becomes the source of truth. The `decided` flag a
// dispatcher returns is informational — the durable write happened in the board
// repository, not here.
//
// `dispatch` is injected so the exchange is testable with fake adapters and the
// real `dispatchChatTurn` wires the runtime adapters + heartbeat-restore.

import type { BudgetScope } from '@clawboo/db'

import type { ChatParticipant, SpeakerPolicy } from './selectNextSpeaker'
import { selectNextSpeaker } from './selectNextSpeaker'

/** Why a bounded exchange stopped. */
export type ExchangeEndReason = 'max_turns' | 'no_pending_obligation' | 'budget_paused' | 'aborted'

/** OpenClaw's `sessions_send` `maxPingPongTurns` default — our reference point. */
export const DEFAULT_MAX_EXCHANGE_TURNS = 5

export interface ChatTurnOutcome {
  /** agentIds this turn obliges to speak next (delegation targets / report-up). */
  obligations: string[]
  /** True when this turn produced a durable BOARD mutation (a decision). */
  decided?: boolean
  /** What the speaker posted (for obs/debug). */
  summary?: string
  /** Set when this turn's recorded spend tripped a CAP budget — the exchange stops
   *  driving further turns (the in-exchange half of the kill-switch). */
  budgetStopped?: BudgetScope | null
}

/** Dispatch ONE turn for a participant; returns what it obliged + whether it decided. */
export type ChatTurnDispatcher = (
  participant: ChatParticipant,
  turnIndex: number,
) => Promise<ChatTurnOutcome>

export interface ExchangeEmit {
  speakerSelected?: (data: {
    roomId: string
    speakerAgentId: string
    policy: SpeakerPolicy
    exchangeTurn: number
  }) => void
  turnBoundHit?: (data: {
    roomId: string
    reason: ExchangeEndReason
    maxExchangeTurns: number
    turnsTaken: number
  }) => void
}

export interface RunExchangeInput {
  roomId: string
  participants: ChatParticipant[]
  /** The agentId(s) seeded to speak first (the stimulus targets). Defaults to the leader. */
  firstSpeakers?: string[]
  dispatch: ChatTurnDispatcher
  emit?: ExchangeEmit
  maxExchangeTurns?: number
  /** Aborts the loop between turns (client disconnect). */
  signal?: AbortSignal
}

export interface ExchangeResult {
  turnsTaken: number
  endedReason: ExchangeEndReason
  /** Ordered agentIds who spoke this exchange. */
  speakers: string[]
}

export async function runExchange(input: RunExchangeInput): Promise<ExchangeResult> {
  const max = input.maxExchangeTurns ?? DEFAULT_MAX_EXCHANGE_TURNS
  const leader = input.participants.find((p) => p.isLeader)
  const seed = input.firstSpeakers ?? (leader ? [leader.agentId] : [])
  const pending = new Set<string>(seed)
  const speakers: string[] = []
  const turnsByAgent = new Map<string, number>()
  let lastSpeaker: string | null = null

  const end = (reason: ExchangeEndReason, turnsTaken: number): ExchangeResult => {
    input.emit?.turnBoundHit?.({ roomId: input.roomId, reason, maxExchangeTurns: max, turnsTaken })
    return { turnsTaken, endedReason: reason, speakers }
  }

  for (let turn = 1; turn <= max; turn++) {
    // Client disconnect (or any caller abort) stops the loop between turns — no
    // further real model turns are dispatched.
    if (input.signal?.aborted) return end('aborted', turn - 1)

    const sel = selectNextSpeaker({
      participants: input.participants,
      lastSpeakerId: lastSpeaker,
      pendingObligations: pending,
      turnsByAgent,
    })
    if (!sel.speaker) return end('no_pending_obligation', turn - 1)

    input.emit?.speakerSelected?.({
      roomId: input.roomId,
      speakerAgentId: sel.speaker.agentId,
      policy: sel.policy,
      exchangeTurn: turn,
    })

    const outcome = await input.dispatch(sel.speaker, turn)
    speakers.push(sel.speaker.agentId)
    turnsByAgent.set(sel.speaker.agentId, (turnsByAgent.get(sel.speaker.agentId) ?? 0) + 1)
    pending.delete(sel.speaker.agentId)
    for (const o of outcome.obligations) if (o !== sel.speaker.agentId) pending.add(o)
    lastSpeaker = sel.speaker.agentId

    // A turn whose recorded spend tripped a CAP budget halts the exchange.
    if (outcome.budgetStopped) return end('budget_paused', turn)

    if (pending.size === 0) return end('no_pending_obligation', turn)
  }

  // Cap reached with work still pending — the chatter-forever guard fired.
  return end('max_turns', max)
}
