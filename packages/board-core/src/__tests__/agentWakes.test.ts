// Helpers waking each other: a person says yes once per job, then the brakes apply.

import { describe, expect, it } from 'vitest'

import {
  AGENT_WAKE_WINDOW_MS,
  afterAgentWakeChain,
  afterAgentWakeHour,
  agentWakeVerdict,
  MAX_AGENT_WAKES_PER_HOUR,
  MAX_BACK_AND_FORTH,
  teammateMayEndWait,
  type AgentWakeChain,
  type AgentWakeGateState,
} from '../agentWakes'
import { taskAttention } from '../attention'
import {
  commentMayWake,
  strongerWakeReason,
  wakeDecision,
  wakeFromPerson,
  type WakeDecisionInput,
} from '../wakes'

const NOW = 10_000_000
const gate = (over: Partial<AgentWakeGateState> = {}): AgentWakeGateState => ({
  decision: 'allow',
  windowStartedAt: null,
  windowCount: 0,
  ...over,
})
const wake = (over: Partial<Parameters<typeof agentWakeVerdict>[1]> = {}) => ({
  fromAgentId: 'a',
  toAgentId: 'b',
  teamAlways: false,
  now: NOW,
  ...over,
})

describe('commentMayWake', () => {
  it('a person’s comment always may', () => {
    expect(commentMayWake({ kind: 'person' })).toBe(true)
    expect(commentMayWake({ kind: 'person' }, { agentWakes: false })).toBe(true)
  })

  it('an agent’s only when a person has not said no, and never by default', () => {
    expect(commentMayWake({ kind: 'agent' })).toBe(false)
    expect(commentMayWake({ kind: 'agent' }, { agentWakes: false })).toBe(false)
    expect(commentMayWake({ kind: 'agent' }, { agentWakes: true })).toBe(true)
  })

  it('no other kind ever does, whatever a job allows', () => {
    for (const kind of ['note', 'result', null, undefined])
      expect(commentMayWake({ kind }, { agentWakes: true })).toBe(false)
  })
})

describe('agentWakeVerdict', () => {
  it('asks when nobody has said yet', () => {
    expect(agentWakeVerdict(null, wake())).toBe('ask')
    expect(agentWakeVerdict(gate({ decision: null }), wake())).toBe('ask')
  })

  it('honours a yes on the job, and the team’s always', () => {
    expect(agentWakeVerdict(gate(), wake())).toBe('allowed')
    expect(agentWakeVerdict(null, wake({ teamAlways: true }))).toBe('allowed')
  })

  it('a no on the job beats the team’s always', () => {
    expect(agentWakeVerdict(gate({ decision: 'deny' }), wake({ teamAlways: true }))).toBe('no')
  })

  it('pauses at the hourly cap, and lets go when the hour is over', () => {
    const full = gate({ windowStartedAt: NOW - 1_000, windowCount: MAX_AGENT_WAKES_PER_HOUR })
    expect(agentWakeVerdict(full, wake())).toBe('hourly_cap')
    expect(agentWakeVerdict(full, wake({ now: NOW + AGENT_WAKE_WINDOW_MS }))).toBe('allowed')
    expect(agentWakeVerdict({ ...full, windowCount: MAX_AGENT_WAKES_PER_HOUR - 1 }, wake())).toBe(
      'allowed',
    )
  })

  it('the cap holds under the team’s always too', () => {
    const full = gate({
      decision: null,
      windowStartedAt: NOW,
      windowCount: MAX_AGENT_WAKES_PER_HOUR,
    })
    expect(agentWakeVerdict(full, wake({ teamAlways: true }))).toBe('hourly_cap')
  })

  it('stops a back-and-forth chain, and only the reply that would go on with it', () => {
    const chain: AgentWakeChain = {
      lastFromAgentId: 'b',
      chainCount: MAX_BACK_AND_FORTH,
      updatedAt: NOW,
    }
    expect(agentWakeVerdict(gate(), wake({ chain }))).toBe('back_and_forth')
    // The same agent saying something again is not a reply: the cap watches that.
    expect(agentWakeVerdict(gate(), wake({ chain, fromAgentId: 'b', toAgentId: 'a' }))).toBe(
      'allowed',
    )
    expect(
      agentWakeVerdict(gate(), wake({ chain: { ...chain, chainCount: MAX_BACK_AND_FORTH - 1 } })),
    ).toBe('allowed')
  })

  it('a chain that went quiet for an hour is over', () => {
    const chain: AgentWakeChain = {
      lastFromAgentId: 'b',
      chainCount: MAX_BACK_AND_FORTH,
      updatedAt: NOW - AGENT_WAKE_WINDOW_MS,
    }
    expect(agentWakeVerdict(gate(), wake({ chain }))).toBe('allowed')
  })

  it('the chain holds under the team’s always, and with no row for the job yet', () => {
    const chain: AgentWakeChain = {
      lastFromAgentId: 'b',
      chainCount: MAX_BACK_AND_FORTH,
      updatedAt: NOW,
    }
    expect(agentWakeVerdict(null, wake({ chain, teamAlways: true }))).toBe('back_and_forth')
  })
})

describe('afterAgentWakeHour', () => {
  it('starts an hour at the first wake and counts within it', () => {
    const one = afterAgentWakeHour(null, NOW)
    expect(one).toEqual({ windowStartedAt: NOW, windowCount: 1 })
    expect(afterAgentWakeHour({ ...gate(), ...one }, NOW + 1)).toEqual({
      windowStartedAt: NOW,
      windowCount: 2,
    })
  })

  it('starts a new hour when the last is over', () => {
    const later = NOW + AGENT_WAKE_WINDOW_MS
    expect(afterAgentWakeHour(gate({ windowStartedAt: NOW, windowCount: 9 }), later)).toEqual({
      windowStartedAt: later,
      windowCount: 1,
    })
  })
})

describe('afterAgentWakeChain', () => {
  it('counts replies between two agents, and saying it twice is no reply', () => {
    let chain: AgentWakeChain | null = null
    const step = (from: string): number => {
      chain = afterAgentWakeChain(chain, from, NOW)
      return chain.chainCount
    }
    expect(step('a')).toBe(1)
    expect(step('b')).toBe(2)
    expect(step('a')).toBe(3)
    expect(step('a')).toBe(3)
    expect(step('b')).toBe(4)
  })

  it('starts again after an hour of quiet', () => {
    const quiet: AgentWakeChain = { lastFromAgentId: 'a', chainCount: 3, updatedAt: NOW }
    expect(afterAgentWakeChain(quiet, 'b', NOW + AGENT_WAKE_WINDOW_MS).chainCount).toBe(1)
  })
})

describe('teammateMayEndWait', () => {
  it('only what an agent said it needs', () => {
    expect(teammateMayEndWait({ kind: 'person', need: 'A key', by: 'agent' })).toBe(true)
  })

  it('not a wait on other work: the board moves that on when the work ends', () => {
    expect(teammateMayEndWait({ kind: 'task', taskId: 't' })).toBe(false)
    expect(teammateMayEndWait({ kind: 'subtasks' })).toBe(false)
    expect(teammateMayEndWait({ kind: 'subtasks', handedOut: true })).toBe(false)
    // Its agent did not ask for this: the engine wrote it, and the sub-tasks coming
    // through is what ends it.
    expect(
      teammateMayEndWait({
        kind: 'person',
        need: 'Part a did not finish.',
        by: 'agent',
        untilSubtasks: true,
      }),
    ).toBe(false)
  })

  it('not a person’s turn, or a stop the system made', () => {
    expect(teammateMayEndWait({ kind: 'person', need: 'x', by: 'person' })).toBe(false)
    expect(teammateMayEndWait({ kind: 'person', need: 'x' })).toBe(false)
    expect(teammateMayEndWait({ kind: 'question', questionId: 'q' })).toBe(false)
    for (const kind of ['failure', 'budget', 'breaker', 'recovery', 'approval'] as const)
      expect(teammateMayEndWait({ kind } as never)).toBe(false)
    expect(teammateMayEndWait({ kind: 'verification', state: 'failed' })).toBe(false)
    expect(teammateMayEndWait(null)).toBe(false)
  })
})

describe('an agent’s comment on the wake rules', () => {
  const base: WakeDecisionInput = {
    reason: 'agent_comment',
    replays: 0,
    status: 'blocked',
    dropped: false,
    hasAgent: true,
    ready: true,
    execs: [],
    runProvenAlive: false,
    held: false,
    paused: false,
    refusal: null,
    budgetRefused: false,
    teammateMayEndWait: true,
    agentWakes: 'allowed',
    now: NOW,
  }

  it('no person is behind it', () => {
    expect(wakeFromPerson('agent_comment')).toBe(false)
  })

  it('moves a task its agent parked once a person has said yes, with nothing forced', () => {
    expect(wakeDecision(base)).toEqual({ do: 'fire', force: false, moveToTodo: true })
  })

  it('waits for the person until then, and says which card', () => {
    expect(wakeDecision({ ...base, agentWakes: 'ask' })).toEqual({ do: 'wait', skip: 'ask_once' })
    expect(wakeDecision({ ...base, agentWakes: 'hourly_cap' })).toEqual({
      do: 'wait',
      skip: 'hourly_cap',
    })
    expect(wakeDecision({ ...base, agentWakes: 'back_and_forth' })).toEqual({
      do: 'wait',
      skip: 'back_and_forth',
    })
  })

  it('a no closes it wherever the task stands', () => {
    for (const status of ['blocked', 'todo', 'in_progress'])
      expect(wakeDecision({ ...base, status, agentWakes: 'no' })).toEqual({
        do: 'settle',
        how: 'declined',
      })
  })

  it('does not end a wait that is not the agent’s own to give up', () => {
    expect(wakeDecision({ ...base, teammateMayEndWait: false })).toEqual({
      do: 'wait',
      skip: 'blocked',
    })
  })

  it('never reaches a person’s turn', () => {
    expect(wakeDecision({ ...base, personAssigned: true })).toEqual({
      do: 'wait',
      skip: 'person_assigned',
    })
    expect(wakeDecision({ ...base, waitingOnQuestion: true })).toEqual({
      do: 'wait',
      skip: 'question',
    })
  })

  it('asks only when it would really start: every brake comes first', () => {
    const ask = { ...base, agentWakes: 'ask' as const }
    expect(wakeDecision({ ...ask, held: true })).toEqual({ do: 'wait', skip: 'held' })
    expect(wakeDecision({ ...ask, ready: false })).toEqual({ do: 'wait', skip: 'dependency' })
    expect(wakeDecision({ ...ask, budgetRefused: true })).toEqual({ do: 'wait', skip: 'budget' })
    expect(wakeDecision({ ...ask, execs: [{ status: 'cancelled' }] })).toEqual({
      do: 'wait',
      skip: 'stopped',
    })
    expect(wakeDecision({ ...ask, execs: [{ status: 'running' }] })).toEqual({
      do: 'wait',
      skip: 'run_unproven',
    })
    const noProgress = [
      { status: 'succeeded', madeProgress: 0, completedAt: NOW - 1 },
      { status: 'succeeded', madeProgress: 0, completedAt: NOW - 1 },
    ]
    expect(wakeDecision({ ...ask, execs: noProgress })).toEqual({ do: 'wait', skip: 'braked' })
  })

  it('a task in To do starts by itself: no card, whatever the job says yet', () => {
    expect(wakeDecision({ ...base, status: 'todo', agentWakes: 'ask' })).toEqual({
      do: 'fire',
      force: false,
      moveToTodo: false,
    })
  })

  it('a dependency finishing is not held behind the card when the two fold together', () => {
    expect(strongerWakeReason('agent_comment', 'dependency_done')).toBe('dependency_done')
    expect(strongerWakeReason('dependency_done', 'agent_comment')).toBe('dependency_done')
    expect(strongerWakeReason('agent_comment', 'person_comment')).toBe('person_comment')
    expect(strongerWakeReason('person_comment', 'agent_comment')).toBe('person_comment')
  })
})

describe('the card in Needs you', () => {
  const card = { jobTaskId: 'job', kind: 'ask', fromAgentId: 'a', toAgentId: 'b' } as const

  it('is its own reason, and carries what it needs', () => {
    expect(
      taskAttention({
        status: 'blocked',
        execs: [{ status: 'succeeded' }],
        waitingOn: { kind: 'person', need: 'A key', by: 'agent' },
        agentWakes: card,
      }),
    ).toMatchObject({ reason: 'agent_wakes', agentWakes: card })
  })

  it('a task waiting on other work stays out of Needs you, card or no card', () => {
    expect(
      taskAttention({
        status: 'blocked',
        execs: [],
        waitingOn: { kind: 'task', taskId: 't' },
        agentWakes: card,
      }),
    ).toBeNull()
  })

  it('a stale card never hides a failure, or the Retry it comes with', () => {
    expect(
      taskAttention({
        status: 'blocked',
        execs: [{ status: 'failed' }],
        waitingOn: { kind: 'failure' },
        agentWakes: card,
      })?.reason,
    ).toBe('failed')
    expect(
      taskAttention({
        status: 'blocked',
        execs: [],
        waitingOn: { kind: 'person', need: 'x', by: 'person' },
        agentWakes: card,
      })?.reason,
    ).toBe('blocked')
    expect(
      taskAttention({
        status: 'todo',
        sourceDelegationId: 'r:deleg:agent:b',
        execs: [],
        agentWakes: card,
      }),
    ).toBeNull()
  })

  it('a question or a person’s own task comes first', () => {
    expect(
      taskAttention({
        status: 'blocked',
        execs: [],
        waitingOn: { kind: 'question', questionId: 'q' },
        agentWakes: card,
      })?.reason,
    ).toBe('question')
    expect(
      taskAttention({
        status: 'blocked',
        execs: [],
        assigneePersonId: 'p',
        waitingOn: { kind: 'person', need: 'x', by: 'agent' },
        agentWakes: card,
      })?.reason,
    ).toBe('assigned')
  })

  it('goes with the task', () => {
    expect(taskAttention({ status: 'done', execs: [], agentWakes: card })).toBeNull()
  })
})
