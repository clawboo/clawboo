// useTeamChatStream frame reconciliation — the pure store-integration half of the
// SSE thin-client contract. Committed frames append (dedup by entryId) and, when an
// assistant turn commits, drop its live delta; delta frames REPLACE the session's
// streaming text + anchor its stream-start. Testable without a live EventSource.

import { beforeEach, describe, expect, it } from 'vitest'

import type { TranscriptEntry } from '@clawboo/protocol'

import { useBoardStore } from '@/stores/board'
import { useChatStore } from '@/stores/chat'
import { useFleetStore, type AgentState } from '@/stores/fleet'

import {
  applyAgentStatusFrame,
  applyBoardChangeFrame,
  applyCommittedFrame,
  applyDeltaFrame,
} from '../useTeamChatStream'

const SK = 'agent:a2:team:t1'

function resetChatStore(): void {
  useChatStore.setState({
    transcripts: new Map(),
    streamingText: new Map(),
    streamStartedAt: new Map(),
    lastTokenUsage: new Map(),
  })
}

function entry(over: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    entryId: 'e1',
    role: 'assistant',
    kind: 'assistant',
    text: 'hello',
    sessionKey: SK,
    runId: 'r1',
    source: 'local-send',
    timestampMs: 1000,
    sequenceKey: 1,
    confirmed: true,
    fingerprint: 'f1',
    ...over,
  }
}

describe('applyCommittedFrame', () => {
  beforeEach(() => resetChatStore())

  it('appends a committed entry under its own sessionKey', () => {
    applyCommittedFrame(JSON.stringify(entry({ entryId: 'x1' })))
    expect(useChatStore.getState().transcripts.get(SK)).toHaveLength(1)
  })

  it('dedups by entryId (SSE full-replay + optimistic bubble land once)', () => {
    const raw = JSON.stringify(entry({ entryId: 'dupe' }))
    applyCommittedFrame(raw)
    applyCommittedFrame(raw)
    expect(useChatStore.getState().transcripts.get(SK)).toHaveLength(1)
  })

  it('drops the live delta when an assistant turn commits', () => {
    const chat = useChatStore.getState()
    chat.setStreamingText(SK, 'streaming…')
    chat.setStreamStart(SK, 500)
    applyCommittedFrame(JSON.stringify(entry({ entryId: 'a', kind: 'assistant' })))
    expect(useChatStore.getState().streamingText.get(SK)).toBeUndefined()
    expect(useChatStore.getState().streamStartedAt.get(SK)).toBeUndefined()
  })

  it('does NOT clear streaming for a non-assistant (meta) commit', () => {
    const chat = useChatStore.getState()
    chat.setStreamingText(SK, 'streaming…')
    applyCommittedFrame(
      JSON.stringify(
        entry({ entryId: 'm', kind: 'meta', role: 'system', text: '[Task Update] x' }),
      ),
    )
    expect(useChatStore.getState().streamingText.get(SK)).toBe('streaming…')
  })

  it('ignores malformed JSON / a frame without a sessionKey', () => {
    applyCommittedFrame('not json')
    applyCommittedFrame(JSON.stringify({ entryId: 'z', text: 'x' }))
    expect(useChatStore.getState().transcripts.size).toBe(0)
  })
})

describe('applyDeltaFrame', () => {
  beforeEach(() => resetChatStore())

  it('REPLACES the session streaming text with the full running text + anchors stream-start', () => {
    applyDeltaFrame(JSON.stringify({ sessionKey: SK, runId: 'r1', text: 'Hel' }))
    expect(useChatStore.getState().streamingText.get(SK)).toBe('Hel')
    applyDeltaFrame(JSON.stringify({ sessionKey: SK, runId: 'r1', text: 'Hello' }))
    expect(useChatStore.getState().streamingText.get(SK)).toBe('Hello')
    expect(useChatStore.getState().streamStartedAt.has(SK)).toBe(true)
  })

  it('ignores a malformed delta', () => {
    applyDeltaFrame('nope')
    applyDeltaFrame(JSON.stringify({ runId: 'r1' }))
    expect(useChatStore.getState().streamingText.size).toBe(0)
  })

  it('an EMPTY text is the CLEAR sentinel — drops the live card + its anchor', () => {
    applyDeltaFrame(JSON.stringify({ sessionKey: SK, runId: 'r1', text: 'streamed then dropped' }))
    expect(useChatStore.getState().streamingText.get(SK)).toBe('streamed then dropped')
    // The server publishes an empty delta when a streamed turn ends with no committed
    // replacement (silent delegation / write-time drop / dead stream) — without this
    // the StreamingCard lingers and later "vanishes" against a wiped transcript.
    applyDeltaFrame(JSON.stringify({ sessionKey: SK, runId: 'r1', text: '' }))
    expect(useChatStore.getState().streamingText.get(SK)).toBeUndefined()
    expect(useChatStore.getState().streamStartedAt.get(SK)).toBeUndefined()
  })
})

describe('applyAgentStatusFrame', () => {
  const agent = (over: Partial<AgentState>): AgentState => ({
    id: 'a2',
    name: 'Data Analyst Boo',
    status: 'idle',
    sessionKey: 'agent:a2:main',
    model: null,
    createdAt: null,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: 't1',
    runtime: 'openclaw',
    execConfig: null,
    ...over,
  })

  beforeEach(() => {
    useFleetStore.setState({ agents: [agent({})] })
  })

  it('patches the fleet status to running (the left-pane Working badge)', () => {
    applyAgentStatusFrame(JSON.stringify({ agentId: 'a2', status: 'running' }))
    expect(useFleetStore.getState().agents[0]?.status).toBe('running')
  })

  it('flips back to idle and freshens last-seen — but NEVER touches runId (the Gateway 1:1 abort handle)', () => {
    useFleetStore.setState({ agents: [agent({ status: 'running', runId: 'r9' })] })
    applyAgentStatusFrame(JSON.stringify({ agentId: 'a2', status: 'idle' }))
    const a = useFleetStore.getState().agents[0]
    expect(a?.status).toBe('idle')
    // A team-run terminal must not clobber a concurrent 1:1 Gateway run's runId
    // (the surgical chat.abort Stop needs it).
    expect(a?.runId).toBe('r9')
    expect(a?.lastSeenAt).not.toBeNull()
  })

  it('is idempotent — repeated same-value frames are harmless', () => {
    applyAgentStatusFrame(JSON.stringify({ agentId: 'a2', status: 'running' }))
    applyAgentStatusFrame(JSON.stringify({ agentId: 'a2', status: 'running' }))
    expect(useFleetStore.getState().agents[0]?.status).toBe('running')
  })

  it('ignores malformed JSON / an unknown status value / an unknown agent', () => {
    applyAgentStatusFrame('not json')
    applyAgentStatusFrame(JSON.stringify({ agentId: 'a2', status: 'sprinting' }))
    applyAgentStatusFrame(JSON.stringify({ agentId: 'ghost', status: 'running' }))
    expect(useFleetStore.getState().agents[0]?.status).toBe('idle')
  })
})

describe('applyBoardChangeFrame', () => {
  beforeEach(() => useBoardStore.getState().reset('t1'))

  it('applies a board change to the board store for the given team', () => {
    applyBoardChangeFrame(
      't1',
      JSON.stringify({ id: 'task-1', title: 'Research', status: 'in_progress', updatedAt: 10 }),
    )
    const task = useBoardStore.getState().tasksByTeam.get('t1')?.get('task-1')
    expect(task?.status).toBe('in_progress')
    expect(task?.title).toBe('Research')
  })

  it('ignores malformed JSON / a frame without an id', () => {
    applyBoardChangeFrame('t1', 'not json')
    applyBoardChangeFrame('t1', JSON.stringify({ status: 'done' }))
    expect(useBoardStore.getState().tasksByTeam.get('t1')).toBeUndefined()
  })
})
