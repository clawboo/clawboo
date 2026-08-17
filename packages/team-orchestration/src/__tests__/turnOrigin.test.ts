// The turn-framing matrix. Every row here was a single boolean before, which is
// why two of them were wrong.

import { describe, expect, it } from 'vitest'

import { classifyTurn, HUMAN_TURN, SYSTEM_TURN, type TurnOrigin } from '../turnOrigin'

const LEADER = 'boo-zero'
const WORKER = 'bug-boo'

const frame = (origin: TurnOrigin, targetAgentId: string, hasBoardTask = false) =>
  classifyTurn({ origin, targetAgentId, leaderAgentId: LEADER, hasBoardTask })

describe('classifyTurn — the cases that already worked', () => {
  it('a human talking to the leader is the leader turn', () => {
    expect(frame(HUMAN_TURN, LEADER)).toEqual({
      isWorker: false,
      isLeader: true,
      isUserFacing: true,
    })
  })

  it('a delegated task is a worker turn, and reaches no user', () => {
    expect(frame({ kind: 'delegation', fromAgentId: LEADER }, WORKER, true)).toEqual({
      isWorker: true,
      isLeader: false,
      isUserFacing: false,
    })
  })

  it('a reflection to the leader keeps BOTH the leader block and the user intro', () => {
    // Clawboo triggered this turn, but what the leader writes in response is the
    // summary the user reads. Withholding the intro here would make the fix worse
    // than the bug at the one place the intro is most useful.
    expect(frame(SYSTEM_TURN, LEADER)).toEqual({
      isWorker: false,
      isLeader: true,
      isUserFacing: true,
    })
  })

  it('a reflection to a mid-chain delegator that still holds its task stays a worker', () => {
    expect(frame(SYSTEM_TURN, WORKER, true)).toMatchObject({ isWorker: true, isLeader: false })
  })

  it('the LEADER executing a delegated task is a worker for that turn', () => {
    expect(frame({ kind: 'delegation', fromAgentId: null }, LEADER, true)).toEqual({
      isWorker: true,
      isLeader: false,
      isUserFacing: false,
    })
  })
})

describe('classifyTurn — the two cases that were wrong', () => {
  it('a system turn to an EX-worker is not a leader turn', () => {
    // THE BUG. `completeForSession` forgets the session on the worker's terminal,
    // so a later `[Task Update]` from a sub-task reporting back to it arrived with
    // no task in the map — and the ex-worker was handed the leader coordination
    // block plus the user's personal intro.
    expect(frame(SYSTEM_TURN, WORKER, false)).toEqual({
      isWorker: false,
      isLeader: false,
      isUserFacing: false,
    })
  })

  it('an @mentioned specialist keeps the user intro but is NOT told it leads', () => {
    // It genuinely is talking to the user, so the intro belongs. It is genuinely
    // not the lead, so "You are the LEAD of this team" does not.
    expect(frame(HUMAN_TURN, WORKER)).toEqual({
      isWorker: false,
      isLeader: false,
      isUserFacing: true,
    })
  })
})

describe('classifyTurn — degenerate input', () => {
  it('a team with no resolvable leader frames nobody as the leader', () => {
    // `resolveLeaderId` returns null for an empty roster. Comparing against null
    // must not make every agent the leader.
    expect(
      classifyTurn({
        origin: SYSTEM_TURN,
        targetAgentId: WORKER,
        leaderAgentId: null,
        hasBoardTask: false,
      }),
    ).toMatchObject({ isLeader: false, isUserFacing: false })
  })

  it('a delegation origin frames work even when the session map has forgotten it', () => {
    // The second witness: a re-fire whose claim already landed still reads as work
    // rather than falling through to a user-facing turn.
    expect(frame({ kind: 'delegation', fromAgentId: LEADER }, WORKER, false)).toMatchObject({
      isWorker: true,
    })
  })
})
