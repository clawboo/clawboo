import { describe, it, expect, beforeEach } from 'vitest'
import { useFleetStore } from '../fleet'
import type { AgentState } from '../fleet'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 'a1',
    name: 'Test Boo',
    status: 'idle',
    sessionKey: 'session-1',
    model: null,
    createdAt: null,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: null,
    ...overrides,
  }
}

function twoAgents(): AgentState[] {
  return [makeAgent({ id: 'a1', name: 'Alpha' }), makeAgent({ id: 'a2', name: 'Beta' })]
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useFleetStore', () => {
  beforeEach(() => {
    // Reset store to initial state
    useFleetStore.setState({ agents: [], selectedAgentId: null })
  })

  it('starts with empty fleet', () => {
    const state = useFleetStore.getState()
    expect(state.agents).toHaveLength(0)
    expect(state.selectedAgentId).toBeNull()
  })

  describe('hydrateAgents', () => {
    it('replaces the full agent list', () => {
      const agents = twoAgents()
      useFleetStore.getState().hydrateAgents(agents)
      expect(useFleetStore.getState().agents).toHaveLength(2)
      expect(useFleetStore.getState().agents[0].name).toBe('Alpha')
    })
  })

  describe('selectAgent', () => {
    it('sets selectedAgentId', () => {
      useFleetStore.getState().selectAgent('a1')
      expect(useFleetStore.getState().selectedAgentId).toBe('a1')
    })

    it('deselects with null', () => {
      useFleetStore.getState().selectAgent('a1')
      useFleetStore.getState().selectAgent(null)
      expect(useFleetStore.getState().selectedAgentId).toBeNull()
    })
  })

  describe('updateAgentStatus', () => {
    it('patches status for the correct agent', () => {
      useFleetStore.getState().hydrateAgents(twoAgents())
      useFleetStore.getState().updateAgentStatus('a1', 'running')
      expect(useFleetStore.getState().agents[0].status).toBe('running')
    })

    it('does not affect other agents', () => {
      useFleetStore.getState().hydrateAgents(twoAgents())
      useFleetStore.getState().updateAgentStatus('a1', 'running')
      expect(useFleetStore.getState().agents[1].status).toBe('idle')
    })
  })

  describe('updateStreamingText', () => {
    it('sets streaming text', () => {
      useFleetStore.getState().hydrateAgents(twoAgents())
      useFleetStore.getState().updateStreamingText('a1', 'hello...')
      expect(useFleetStore.getState().agents[0].streamingText).toBe('hello...')
    })

    it('clears with null', () => {
      useFleetStore.getState().hydrateAgents(twoAgents())
      useFleetStore.getState().updateStreamingText('a1', 'hello...')
      useFleetStore.getState().updateStreamingText('a1', null)
      expect(useFleetStore.getState().agents[0].streamingText).toBeNull()
    })
  })

  describe('patchAgent', () => {
    it('applies partial status patch', () => {
      useFleetStore.getState().hydrateAgents(twoAgents())
      useFleetStore.getState().patchAgent('a1', { status: 'running', runId: 'run-1' })
      const agent = useFleetStore.getState().agents[0]
      expect(agent.status).toBe('running')
      expect(agent.runId).toBe('run-1')
    })

    it('applies streamText patch', () => {
      useFleetStore.getState().hydrateAgents(twoAgents())
      useFleetStore.getState().patchAgent('a1', { streamText: 'thinking...' })
      expect(useFleetStore.getState().agents[0].streamingText).toBe('thinking...')
    })

    it('does not modify unset fields', () => {
      useFleetStore.getState().hydrateAgents(twoAgents())
      useFleetStore.getState().patchAgent('a1', { status: 'running' })
      const agent = useFleetStore.getState().agents[0]
      expect(agent.runId).toBeNull() // unchanged
      expect(agent.streamingText).toBeNull() // unchanged
    })
  })

  describe('removeAgent', () => {
    it('filters out the agent', () => {
      useFleetStore.getState().hydrateAgents(twoAgents())
      useFleetStore.getState().removeAgent('a1')
      expect(useFleetStore.getState().agents).toHaveLength(1)
      expect(useFleetStore.getState().agents[0].id).toBe('a2')
    })

    it('deselects if removed agent was selected', () => {
      useFleetStore.getState().hydrateAgents(twoAgents())
      useFleetStore.getState().selectAgent('a1')
      useFleetStore.getState().removeAgent('a1')
      expect(useFleetStore.getState().selectedAgentId).toBeNull()
    })

    it('keeps selection if different agent removed', () => {
      useFleetStore.getState().hydrateAgents(twoAgents())
      useFleetStore.getState().selectAgent('a1')
      useFleetStore.getState().removeAgent('a2')
      expect(useFleetStore.getState().selectedAgentId).toBe('a1')
    })
  })

  describe('updateLastSeen', () => {
    it('sets lastSeenAt for the correct agent', () => {
      useFleetStore.getState().hydrateAgents(twoAgents())
      useFleetStore.getState().updateLastSeen('a1', 1700000000000)
      expect(useFleetStore.getState().agents[0].lastSeenAt).toBe(1700000000000)
    })

    it('does not affect other agents', () => {
      useFleetStore.getState().hydrateAgents(twoAgents())
      useFleetStore.getState().updateLastSeen('a1', 1700000000000)
      expect(useFleetStore.getState().agents[1].lastSeenAt).toBeNull()
    })

    it('overwrites previous timestamp', () => {
      useFleetStore.getState().hydrateAgents(twoAgents())
      useFleetStore.getState().updateLastSeen('a1', 1700000000000)
      useFleetStore.getState().updateLastSeen('a1', 1700000001000)
      expect(useFleetStore.getState().agents[0].lastSeenAt).toBe(1700000001000)
    })
  })
})
