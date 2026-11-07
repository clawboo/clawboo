// ─── Helpers waking each other ──────────────────────────────────────────────
// A person is asked once per job whether its agents may wake each other, and after
// that they may, within brakes. Until they say yes, only a person's comment wakes an
// agent. These are the rules over what @clawboo/db keeps: one row per job for the
// decision and the hourly count (`agent_wake_gates`), and one per pair of agents in a
// team for a back-and-forth (`agent_wake_chains`). Import-free apart from the waiting
// reason, like the state machine.

import type { WaitingOn } from './waitingOn'

/** Agent-to-agent wakes a job may start in an hour before it pauses and says so. */
export const MAX_AGENT_WAKES_PER_HOUR = 12
export const AGENT_WAKE_WINDOW_MS = 60 * 60_000
/** Wakes in a row answering each other, between two agents, before the next is stopped. */
export const MAX_BACK_AND_FORTH = 4

/** Why a person is being asked, on the card in Needs you. */
export type AgentWakeCardKind = 'ask' | 'hourly_cap' | 'back_and_forth'

/** What a person presses on that card. */
export type AgentWakeChoice = 'job' | 'team' | 'no'

/** What the card carries, on a task's attention. */
export interface AgentWakeCard {
  /** The job the decision is about: the task's top-level ancestor. */
  jobTaskId: string
  kind: AgentWakeCardKind
  fromAgentId: string | null
  toAgentId: string | null
  /** For `ask`: other tasks waiting on this answer, which it covers too. */
  alsoWaiting?: number
}

/** May this agent wake that one now? */
export type AgentWakeVerdict = 'allowed' | 'ask' | 'no' | 'hourly_cap' | 'back_and_forth'

/** The decision and the hourly count, as the job's row keeps them. */
export interface AgentWakeGateState {
  /** What a person said: `allow` or `deny`. Null: not asked yet, or not answered. */
  decision: string | null
  windowStartedAt: number | null
  windowCount: number
}

/** Two agents answering each other, as the pair's row keeps it. Per pair in a team, not
 *  per job: two helpers with a top-level task each are two jobs and one conversation. */
export interface AgentWakeChain {
  /** Who woke the other last. */
  lastFromAgentId: string | null
  chainCount: number
  updatedAt: number
}

export interface AgentWakeAttempt {
  fromAgentId: string | null
  toAgentId: string | null
  /** The team said "always allow". */
  teamAlways?: boolean
  /** The pair's row, if they have one. */
  chain?: AgentWakeChain | null
  now: number
}

const withinTheHour = (at: number, now: number): boolean => now - at < AGENT_WAKE_WINDOW_MS

/** The decision comes first, then the brakes. A no on the job outranks the team's
 *  always, because it is the more particular thing a person said. */
export function agentWakeVerdict(
  gate: AgentWakeGateState | null,
  w: AgentWakeAttempt,
): AgentWakeVerdict {
  if (gate?.decision === 'deny') return 'no'
  if (gate?.decision !== 'allow' && !w.teamAlways) return 'ask'
  if (
    gate &&
    gate.windowStartedAt !== null &&
    withinTheHour(gate.windowStartedAt, w.now) &&
    gate.windowCount >= MAX_AGENT_WAKES_PER_HOUR
  )
    return 'hourly_cap'
  const chain = w.chain
  if (
    chain &&
    withinTheHour(chain.updatedAt, w.now) &&
    chain.lastFromAgentId === w.toAgentId &&
    chain.chainCount >= MAX_BACK_AND_FORTH
  )
    return 'back_and_forth'
  return 'allowed'
}

/** The job's count after a wake really started a run. */
export function afterAgentWakeHour(
  gate: Pick<AgentWakeGateState, 'windowStartedAt' | 'windowCount'> | null,
  now: number,
): Pick<AgentWakeGateState, 'windowStartedAt' | 'windowCount'> {
  return gate?.windowStartedAt != null && withinTheHour(gate.windowStartedAt, now)
    ? { windowStartedAt: gate.windowStartedAt, windowCount: gate.windowCount + 1 }
    : { windowStartedAt: now, windowCount: 1 }
}

/** The pair's chain after a wake really started a run. Saying something twice is no
 *  reply, so it leaves the chain as it is, and the hourly cap is what watches for it. A
 *  chain that went quiet for an hour is over. */
export function afterAgentWakeChain(
  chain: AgentWakeChain | null,
  fromAgentId: string | null,
  now: number,
): AgentWakeChain {
  if (!chain || !withinTheHour(chain.updatedAt, now))
    return { lastFromAgentId: fromAgentId, chainCount: 1, updatedAt: now }
  return {
    lastFromAgentId: fromAgentId,
    chainCount: chain.lastFromAgentId === fromAgentId ? chain.chainCount : chain.chainCount + 1,
    updatedAt: now,
  }
}

/**
 * Could a teammate's comment end this wait? Only what the agent itself said it needs.
 * A wait on other work ends when that work does, and a comment clearing it would leave
 * nothing waiting when the work closes. A question, a hand-back or a card a person moved
 * is a person's turn, and a failure, a check, a budget or a recovery is a stop that a
 * comment does not lift.
 */
export function teammateMayEndWait(waiting: WaitingOn | null | undefined): boolean {
  return waiting?.kind === 'person' && waiting.by === 'agent'
}
