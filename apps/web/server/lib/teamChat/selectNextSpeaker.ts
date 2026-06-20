// ─── Speaker-selection (who-talks-next) ──────────────────────────────────────
// The conversational group-chat topology the field guide flags as its own
// problem: a manager picks who speaks next each turn. Prior art is autogen/ag2,
// where "the only thing that varies across its topologies is select_speaker"
// (round-robin / nominated-next / LLM-selected / progress-ledger). We ship a
// simple, DETERMINISTIC default isolated behind one pure function so a richer
// LLM-selected policy can replace it later without touching the exchange loop.
//
// Policy: a participant with a PENDING OBLIGATION (a delegation target, or the
// leader owed a report-up) speaks next, in stable order, never the same speaker
// twice in a row when an alternative exists (round-robin). With no pending
// obligation, the LEADER is nominated (leader-nominated) if it hasn't just
// spoken. Otherwise the exchange has nothing to say → null (it ends).
//
// This governs NARRATION ONLY. The board stays canonical: a decision lands as a
// board mutation, never as chat consensus (see exchange.ts).

export interface ChatParticipant {
  agentId: string
  /** Owning runtime id (open set incl. 'human' — the human-participant seam). */
  runtime: string
  isLeader: boolean
}

export type SpeakerPolicy = 'leader-nominated' | 'round-robin'

export interface SpeakerSelectionInput {
  participants: ChatParticipant[]
  /** The agentId that spoke last (avoid immediate self-repeat when possible). */
  lastSpeakerId: string | null
  /** agentIds that currently owe a turn (delegation targets / report-up). */
  pendingObligations: ReadonlySet<string>
  /** How many turns each agent has taken this exchange — fairness for round-robin
   *  (serve the least-spoken pending participant first, so no one is starved). */
  turnsByAgent?: ReadonlyMap<string, number>
}

export interface SpeakerSelection {
  speaker: ChatParticipant | null
  policy: SpeakerPolicy
}

function byAgentId(participants: ChatParticipant[]): ChatParticipant[] {
  return [...participants].sort((a, b) =>
    a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0,
  )
}

export function selectNextSpeaker(input: SpeakerSelectionInput): SpeakerSelection {
  const count = (id: string): number => input.turnsByAgent?.get(id) ?? 0
  const obligated = byAgentId(
    input.participants.filter((p) => input.pendingObligations.has(p.agentId)),
  )

  if (obligated.length > 0) {
    // Round-robin with fairness: serve the pending participant who has spoken the
    // FEWEST times (so the leader can't starve specialists just by being owed a
    // report-up every turn); tie-break by agentId; avoid the immediate self-repeat
    // unless that participant is the only one owed.
    const minCount = Math.min(...obligated.map((p) => count(p.agentId)))
    const fairest = obligated.filter((p) => count(p.agentId) === minCount)
    const next = fairest.find((p) => p.agentId !== input.lastSpeakerId) ?? fairest[0]!
    return { speaker: next, policy: 'round-robin' }
  }

  // No pending obligation → nominate the leader to drive, unless it just spoke.
  const leader = input.participants.find((p) => p.isLeader)
  if (leader && leader.agentId !== input.lastSpeakerId) {
    return { speaker: leader, policy: 'leader-nominated' }
  }

  return { speaker: null, policy: 'leader-nominated' }
}
