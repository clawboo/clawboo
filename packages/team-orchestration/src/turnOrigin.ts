// Why a run is happening — stamped by whoever asks for it, never inferred.
//
// THE BUG THIS REPLACES. `serverDeliver` decided whether a turn was the
// user-facing leader turn or a delegated worker turn from ONE boolean,
// `taskForSession(sessionKey) != null`. That map is correct while a delegation is
// in flight and wrong the moment it ends: `completeForSession` calls
// `forgetSession` on the worker's terminal, so every LATER delivery to that same
// session — a late `[Task Update]` from a sub-task that reports back to it, an
// alert naming it, a peer signal — read as "no task, therefore the leader". The
// ex-worker was then handed the leader coordination block telling it to run the
// team, plus `[About the User]`, the user's personal intro that exists precisely
// to be withheld from agents that are not talking to the user.
//
// The 60s `RECENTLY_TERMINATED_TTL_MS` guard does not cover this. It stops a stale
// terminal from spawning work; it does not stop a genuinely NEW turn arriving
// after it expires, and such a turn delegating with `sourceTaskId = null` opens a
// fresh depth-0 subtree from what is really a leaf.
//
// WHY A TYPE AND NOT A BETTER HEURISTIC. Every heuristic here guesses at something
// the caller already knows for certain. The engine knows it is firing a
// delegation; the chat route knows a human typed; the reflection batcher knows it
// is neither. Passing that fact costs one argument and makes the classification
// impossible to get wrong by timing.

/**
 * The reason a turn is being delivered.
 *
 * `schedule` is deliberately absent: routines dispatch through their own path and
 * never reach `deliver`, and a variant no caller can produce is a variant no test
 * can cover. Add it when something actually stamps it.
 */
export type TurnOrigin =
  /** A human typed into team chat — the leader, or a specialist they @mentioned. */
  | { kind: 'human' }
  /** A peer delegated this task. `fromAgentId` is the delegator (the reduce point
   *  its result reports to), or null when the engine could not attribute one. */
  | { kind: 'delegation'; fromAgentId: string | null }
  /** Clawboo itself: a batched `[Task Update]` reflection, an alert, a pump
   *  re-fire. No human is waiting on the other end of this particular turn. */
  | { kind: 'system' }

/** Convenience singletons — these two variants carry no payload. */
export const HUMAN_TURN: TurnOrigin = { kind: 'human' }
export const SYSTEM_TURN: TurnOrigin = { kind: 'system' }

/** What a turn IS, decided once and read by everything that frames it. */
export interface TurnFraming {
  /** Executing a board task delegated to it. Gets the worker guardrail. */
  isWorker: boolean
  /** The team's reduce point, on a turn where it is not itself a worker. Gets the
   *  leader coordination block. */
  isLeader: boolean
  /** This turn's output reaches the human. Gates `[About the User]`. */
  isUserFacing: boolean
}

/**
 * Classify a turn.
 *
 * The three questions were previously one boolean, which is why they could not all
 * be answered correctly at once:
 *
 *   • **worker** — is it executing a delegated board task? The origin says so
 *     directly; `hasBoardTask` is kept as the second witness so a re-fire of an
 *     already-claimed task (stamped `system`) is still framed as work.
 *   • **leader** — is this agent the team's reduce point? A property of WHO it is,
 *     not of what the session map currently remembers. This is the fix.
 *   • **user-facing** — can this turn's reply reach the human? True when a human
 *     addressed it (including an @mentioned specialist, which used to be told it
 *     was the team lead) and true for the leader, whose synthesis of a reflection
 *     is written for the user even though clawboo triggered it.
 */
export function classifyTurn(input: {
  origin: TurnOrigin
  targetAgentId: string
  leaderAgentId: string | null
  hasBoardTask: boolean
}): TurnFraming {
  const isWorker = input.origin.kind === 'delegation' || input.hasBoardTask
  const isLeader =
    !isWorker && input.leaderAgentId !== null && input.targetAgentId === input.leaderAgentId
  return { isWorker, isLeader, isUserFacing: input.origin.kind === 'human' || isLeader }
}
