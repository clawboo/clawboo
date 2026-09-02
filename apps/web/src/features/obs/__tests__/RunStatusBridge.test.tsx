// RunStatusBridge — the two requirements that pull against each other.
//
// This component has broken twice, in opposite directions, and a fix for either
// one alone reintroduces the other. Both are pinned here.
//
//  1. THE RACE. The fleet hydrates independently of the event tail and either can
//     win. The effect used to depend on `events` alone, so it ran once against an
//     empty fleet, every `agents.find` missed, and no status was ever applied.
//     The graph stayed dark exactly as if the bridge were not mounted. Fixed by
//     keying the effect on the agent id SET.
//
//  2. THE CLOBBER. The tail is a WINDOW, not a history. A completed execution
//     stays in it long after the run ended, so re-folding the whole window on
//     every frame kept re-asserting `idle`. Once a CHAT run marked the same agent
//     running, the next unrelated event reset it underneath a live run.
//
// A fix for (2) that folds only fresh events breaks (1), because a late-arriving
// agent has no fresh events. A fix for (1) that re-folds the window breaks (2).
// The bridge resolves it by folding the window ONCE PER AGENT and only new
// evidence after that, which is what these tests hold in place.
//
// `useObsStream` is mocked rather than driven through msw: the bug is in the
// fold, not the transport, and feeding events directly is what lets a test say
// "the same window arrived again" — the precise condition that caused it.

import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useRunActivityStore } from '@/stores/runActivity'

import type { ObsLogEvent } from '../useObsStream'

let streamEvents: ObsLogEvent[] = []
vi.mock('../useObsStream', () => ({
  useObsStream: () => ({ events: streamEvents, error: null, connected: true }),
}))

// Imported after the mock so the component picks it up.
const { RunStatusBridge } = await import('../RunStatusBridge')

let seq = 0
function ev(kind: string, agentId: string, data: Record<string, unknown> = {}): ObsLogEvent {
  seq += 1
  return {
    id: `e${seq}`,
    seq,
    ts: 1_000_000 + seq,
    kind,
    teamId: null,
    taskId: 't1',
    agentId,
    runtime: null,
    traceId: null,
    data,
  }
}

function agent(id: string, status: AgentState['status'] = 'idle'): AgentState {
  return {
    id,
    name: id,
    status,
    sessionKey: null,
    model: null,
    createdAt: null,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: null,
  } as AgentState
}

const statusOf = (id: string) => useFleetStore.getState().agents.find((a) => a.id === id)?.status

beforeEach(() => {
  seq = 0
  streamEvents = []
  useFleetStore.setState({ agents: [] })
  useRunActivityStore.setState({ byAgent: new Map() })
})

afterEach(() => vi.clearAllMocks())

describe('RunStatusBridge', () => {
  it('lights an agent up from the window when the fleet is already loaded', () => {
    useFleetStore.setState({ agents: [agent('a1')] })
    streamEvents = [ev('execution_started', 'a1')]

    render(<RunStatusBridge />)

    expect(statusOf('a1')).toBe('running')
  })

  it('still applies to an agent that joins AFTER the tail landed (the race)', () => {
    // The fleet is empty when the backfill arrives, which is the real boot order:
    // the bridge mounts beside GatewayBootstrap, before the fleet hydrates.
    streamEvents = [ev('execution_started', 'a1')]
    render(<RunStatusBridge />)
    expect(statusOf('a1')).toBeUndefined()

    // The agent arrives with no new events behind it. Folding only fresh events
    // would leave it idle forever. `act` so React flushes the effect the store
    // update triggers, rather than the assertion racing it.
    act(() => {
      useFleetStore.setState({ agents: [agent('a1')] })
    })

    expect(statusOf('a1')).toBe('running')
  })

  it('applies to an agent that joins after the watermark has already advanced', () => {
    // The case an empty-fleet test CANNOT reach. With a PARTIALLY loaded fleet the
    // effect really runs, so the watermark advances past both agents' events.
    // When the second agent arrives there is no fresh evidence left for it, and
    // folding only fresh events strands it as idle forever. This is the test that
    // fails if the once-per-agent backfill is removed.
    useFleetStore.setState({ agents: [agent('a1')] })
    streamEvents = [ev('execution_started', 'a1'), ev('execution_started', 'a2')]
    render(<RunStatusBridge />)
    expect(statusOf('a1')).toBe('running')

    act(() => {
      useFleetStore.setState({ agents: [agent('a1', 'running'), agent('a2')] })
    })

    expect(statusOf('a2')).toBe('running')
  })

  it('does NOT reset a chat run that started after a completed board run', () => {
    // The board run finishes. Its completion stays in the window.
    useFleetStore.setState({ agents: [agent('a1')] })
    streamEvents = [
      ev('execution_started', 'a1'),
      ev('execution_completed', 'a1', { status: 'ok' }),
    ]
    const { rerender } = render(<RunStatusBridge />)
    expect(statusOf('a1')).toBe('idle')

    // A chat run now marks the same agent running. Chat writes the fleet store
    // directly and emits no execution events.
    act(() => {
      useFleetStore.getState().updateAgentStatus('a1', 'running')
    })

    // An unrelated event arrives. The completed execution is STILL in the window,
    // so a full re-fold would say 'idle' and clobber the live chat run.
    streamEvents = [...streamEvents, ev('tool_call', 'other')]
    rerender(<RunStatusBridge />)

    expect(statusOf('a1')).toBe('running')
  })

  it('a genuinely new completion still reaches an agent it has already folded', () => {
    // The inverse guard: the watermark must not deafen the bridge to real events.
    useFleetStore.setState({ agents: [agent('a1')] })
    streamEvents = [ev('execution_started', 'a1')]
    const { rerender } = render(<RunStatusBridge />)
    expect(statusOf('a1')).toBe('running')

    streamEvents = [...streamEvents, ev('execution_completed', 'a1', { status: 'ok' })]
    rerender(<RunStatusBridge />)

    expect(statusOf('a1')).toBe('idle')
  })

  it('reports a failed execution as error, which is what shows the bubble', () => {
    // The only producer of fleet status 'error' for a board run, and the input
    // BooNode's `showsBubble = isRunning || status === 'error'` depends on.
    useFleetStore.setState({ agents: [agent('a1')] })
    streamEvents = [
      ev('execution_started', 'a1'),
      ev('execution_completed', 'a1', { status: 'failed' }),
    ]

    render(<RunStatusBridge />)

    expect(statusOf('a1')).toBe('error')
  })

  it('leaves an agent the window says nothing about alone', () => {
    useFleetStore.setState({ agents: [agent('a1'), agent('chatty', 'running')] })
    streamEvents = [ev('execution_started', 'a1')]

    render(<RunStatusBridge />)

    expect(statusOf('a1')).toBe('running')
    // Evidence-only: a chat run with no execution events is never reset.
    expect(statusOf('chatty')).toBe('running')
  })
})
