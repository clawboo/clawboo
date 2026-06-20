import { describe, expect, it, vi } from 'vitest'

import { runExchange, type ChatTurnOutcome } from '../exchange'
import type { ChatParticipant } from '../selectNextSpeaker'

const team: ChatParticipant[] = [
  { agentId: 'leader', runtime: 'openclaw', isLeader: true },
  { agentId: 'claude', runtime: 'claude-code', isLeader: false },
  { agentId: 'hermes', runtime: 'hermes', isLeader: false },
]

describe('runExchange (bounded ping-pong)', () => {
  it('ends cleanly when no obligation remains (leader speaks, nothing pending)', async () => {
    const dispatch = vi.fn(async (): Promise<ChatTurnOutcome> => ({ obligations: [] }))
    const turnBoundHit = vi.fn()
    const res = await runExchange({
      roomId: 'team:t1',
      participants: team,
      dispatch,
      emit: { turnBoundHit },
    })
    expect(res.endedReason).toBe('no_pending_obligation')
    expect(res.speakers).toEqual(['leader'])
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(turnBoundHit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'no_pending_obligation' }),
    )
  })

  it('fans out then drains: leader delegates, specialists report up, leader synthesizes', async () => {
    const dispatch = vi.fn(async (p: ChatParticipant): Promise<ChatTurnOutcome> => {
      if (p.isLeader) {
        // The leader's FIRST turn delegates; its later turns synthesize (no obligation).
        return dispatch.mock.calls.length === 1
          ? { obligations: ['claude', 'hermes'], decided: true }
          : { obligations: [] }
      }
      return { obligations: ['leader'] } // a specialist owes the leader a report-up
    })
    const res = await runExchange({
      roomId: 'team:t1',
      participants: team,
      dispatch,
      maxExchangeTurns: 8,
    })
    // leader → claude → hermes → leader(synthesize) → ends
    expect(res.speakers).toEqual(['leader', 'claude', 'hermes', 'leader'])
    expect(res.endedReason).toBe('no_pending_obligation')
  })

  it('hits the turn cap when work never drains (the chatter-forever guard)', async () => {
    // Every turn re-obligates the leader → pending never empties → cap fires.
    const dispatch = vi.fn(async (p: ChatParticipant): Promise<ChatTurnOutcome> => {
      if (p.isLeader) return { obligations: ['claude'] }
      return { obligations: ['leader'] }
    })
    const turnBoundHit = vi.fn()
    const speakerSelected = vi.fn()
    const res = await runExchange({
      roomId: 'team:t1',
      participants: team,
      dispatch,
      maxExchangeTurns: 4,
      emit: { turnBoundHit, speakerSelected },
    })
    expect(res.turnsTaken).toBe(4)
    expect(res.endedReason).toBe('max_turns')
    expect(turnBoundHit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'max_turns', maxExchangeTurns: 4, turnsTaken: 4 }),
    )
    expect(speakerSelected).toHaveBeenCalledTimes(4)
  })

  it('stops with budget_paused when a turn reports it tripped a cap (in-exchange kill-switch)', async () => {
    const dispatch = vi.fn(
      async (p: ChatParticipant): Promise<ChatTurnOutcome> =>
        p.agentId === 'leader'
          ? { obligations: ['claude', 'hermes'], budgetStopped: 'team' }
          : { obligations: [] },
    )
    const res = await runExchange({
      roomId: 'team:t1',
      participants: team,
      dispatch,
      maxExchangeTurns: 8,
    })
    // The leader's turn tripped the cap → no further turns are driven.
    expect(res.endedReason).toBe('budget_paused')
    expect(res.turnsTaken).toBe(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('aborts before dispatching when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const dispatch = vi.fn(async (): Promise<ChatTurnOutcome> => ({ obligations: [] }))
    const res = await runExchange({
      roomId: 'team:t1',
      participants: team,
      firstSpeakers: ['leader'],
      dispatch,
      signal: controller.signal,
    })
    expect(res.endedReason).toBe('aborted')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('stops mid-exchange when the signal fires after a turn (client disconnect)', async () => {
    const controller = new AbortController()
    const dispatch = vi.fn(async (): Promise<ChatTurnOutcome> => {
      controller.abort() // a disconnect during the first turn (whoever speaks)
      return { obligations: ['claude', 'hermes'] } // keep pending non-empty so the loop would otherwise continue
    })
    const res = await runExchange({
      roomId: 'team:t1',
      participants: team,
      firstSpeakers: ['leader'],
      dispatch,
      signal: controller.signal,
    })
    expect(dispatch).toHaveBeenCalledTimes(1) // only the first turn ran; the abort stopped the rest
    expect(res.endedReason).toBe('aborted')
  })
})
