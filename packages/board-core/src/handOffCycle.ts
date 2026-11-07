// ─── The hand-off cycle rule ────────────────────────────────────────────────
// An agent working on a task must not hand work back to an agent still waiting on
// it: A hands to B, B hands to A, and each waits for the other. So a hand-off is
// refused when its target delegated any open task on the sender's chain, the
// sender's own task included. The team lead is exempt at the call sites: every
// team agent is told to take a blocker to the lead, and the lead delegated most
// top-level tasks.
//
// The one rule, for the team engine and the Tasks tools alike. Import-free.

import { isTerminal, type TaskStatus } from './state-machine'

/** One task on a chain, nearest first, and the agent that handed it out. */
export interface HandOffLink {
  id: string
  status: string
  /** The agent that handed the task out; null when a person made or assigned it. */
  delegatedBy: string | null
  title: string
  identifier: string | null
}

export interface HandOffCycleOptions {
  /**
   * The task the sender's run is working on. It counts as open even once closed:
   * a run's closing message is read after the run's task is marked done, and a
   * hand-off in that message still goes back to whoever waits on the result.
   */
  ownTaskId?: string | null
}

/** The open task on `chain` that `targetAgentId` delegated, or null when there is none. */
export function findHandOffCycle(
  chain: readonly HandOffLink[],
  targetAgentId: string,
  opts: HandOffCycleOptions = {},
): HandOffLink | null {
  for (const link of chain) {
    if (link.delegatedBy !== targetAgentId) continue
    if (link.id === opts.ownTaskId || !isTerminal(link.status as TaskStatus)) return link
  }
  return null
}
