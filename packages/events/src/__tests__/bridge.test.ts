import { describe, it, expect } from 'vitest'
import { classifyEvent, parseChatPayload, parseAgentPayload, isReasoningStream } from '../bridge'
import type { EventFrame } from '@clawboo/gateway-client'

describe('classifyEvent', () => {
  it('classifies presence events as summary-refresh', () => {
    const frame: EventFrame = { type: 'event', event: 'presence', payload: {} }
    expect(classifyEvent(frame).kind).toBe('summary-refresh')
  })

  it('classifies heartbeat events as summary-refresh', () => {
    const frame: EventFrame = { type: 'event', event: 'heartbeat', payload: {} }
    expect(classifyEvent(frame).kind).toBe('summary-refresh')
  })

  it('classifies chat events as runtime-chat', () => {
    const frame: EventFrame = {
      type: 'event',
      event: 'chat',
      payload: { sessionKey: 'agent:a1:main', runId: 'r1', state: 'delta' },
    }
    const result = classifyEvent(frame)
    expect(result.kind).toBe('runtime-chat')
    expect(result.agentId).toBe('a1')
  })

  it('classifies agent events as runtime-agent', () => {
    const frame: EventFrame = {
      type: 'event',
      event: 'agent',
      payload: { agentId: 'a1', runId: 'r1', stream: 'lifecycle' },
    }
    const result = classifyEvent(frame)
    expect(result.kind).toBe('runtime-agent')
    expect(result.agentId).toBe('a1')
  })

  it('classifies exec.approval.pending as approval', () => {
    const frame: EventFrame = {
      type: 'event',
      event: 'exec.approval.pending',
      payload: { agentId: 'a1' },
    }
    expect(classifyEvent(frame).kind).toBe('approval')
  })

  it('classifies exec.approval.resolved as approval', () => {
    const frame: EventFrame = {
      type: 'event',
      event: 'exec.approval.resolved',
      payload: { agentId: 'a1' },
    }
    expect(classifyEvent(frame).kind).toBe('approval')
  })

  it('classifies unknown events', () => {
    const frame: EventFrame = {
      type: 'event',
      event: 'some.unknown.event',
      payload: {},
    }
    expect(classifyEvent(frame).kind).toBe('unknown')
  })

  it('extracts agentId from sessionKey pattern', () => {
    const frame: EventFrame = {
      type: 'event',
      event: 'chat',
      payload: { sessionKey: 'agent:abc-123:main' },
    }
    expect(classifyEvent(frame).agentId).toBe('abc-123')
  })

  it('returns undefined agentId when chat has no sessionKey', () => {
    const frame: EventFrame = { type: 'event', event: 'chat', payload: {} }
    expect(classifyEvent(frame).agentId).toBeUndefined()
  })

  it('prefers explicit agentId over sessionKey for agent events', () => {
    const frame: EventFrame = {
      type: 'event',
      event: 'agent',
      payload: { agentId: 'explicit-id', sessionKey: 'agent:session-id:main' },
    }
    expect(classifyEvent(frame).agentId).toBe('explicit-id')
  })

  it('falls back to sessionKey extraction for agent events without agentId', () => {
    const frame: EventFrame = {
      type: 'event',
      event: 'agent',
      payload: { sessionKey: 'agent:fallback-id:main', runId: 'r1' },
    }
    expect(classifyEvent(frame).agentId).toBe('fallback-id')
  })

  it('extracts agentId from approval payload', () => {
    const frame: EventFrame = {
      type: 'event',
      event: 'exec.approval.pending',
      payload: { agentId: 'approval-agent' },
    }
    expect(classifyEvent(frame).agentId).toBe('approval-agent')
  })
})

describe('parseChatPayload', () => {
  it('parses valid delta payload', () => {
    const result = parseChatPayload({
      runId: 'r1',
      sessionKey: 'sk1',
      state: 'delta',
      message: 'hello',
    })
    expect(result).not.toBeNull()
    expect(result!.state).toBe('delta')
    expect(result!.runId).toBe('r1')
    expect(result!.sessionKey).toBe('sk1')
  })

  it('parses valid final payload', () => {
    const result = parseChatPayload({
      runId: 'r1',
      sessionKey: 'sk1',
      state: 'final',
      message: 'done',
    })
    expect(result).not.toBeNull()
    expect(result!.state).toBe('final')
  })

  it('parses valid error payload with errorMessage', () => {
    const result = parseChatPayload({
      runId: 'r1',
      sessionKey: 'sk1',
      state: 'error',
      errorMessage: 'something broke',
    })
    expect(result).not.toBeNull()
    expect(result!.state).toBe('error')
    expect(result!.errorMessage).toBe('something broke')
  })

  it('returns null for missing runId', () => {
    expect(parseChatPayload({ sessionKey: 'sk1', state: 'delta' })).toBeNull()
  })

  it('returns null for missing sessionKey', () => {
    expect(parseChatPayload({ runId: 'r1', state: 'delta' })).toBeNull()
  })

  it('returns null for invalid state', () => {
    expect(parseChatPayload({ runId: 'r1', sessionKey: 'sk1', state: 'invalid' })).toBeNull()
  })

  it('returns null for null payload', () => {
    expect(parseChatPayload(null)).toBeNull()
  })

  it('returns null for non-object payload', () => {
    expect(parseChatPayload('string')).toBeNull()
  })

  it('includes optional seq and stopReason when present', () => {
    const result = parseChatPayload({
      runId: 'r1',
      sessionKey: 'sk1',
      state: 'final',
      seq: 5,
      stopReason: 'end_turn',
    })
    expect(result!.seq).toBe(5)
    expect(result!.stopReason).toBe('end_turn')
  })
})

describe('parseAgentPayload', () => {
  it('parses valid agent payload', () => {
    const result = parseAgentPayload({
      runId: 'r1',
      stream: 'lifecycle',
      data: { phase: 'start' },
    })
    expect(result).not.toBeNull()
    expect(result!.runId).toBe('r1')
    expect(result!.stream).toBe('lifecycle')
    expect(result!.data).toEqual({ phase: 'start' })
  })

  it('returns null for missing runId', () => {
    expect(parseAgentPayload({ stream: 'lifecycle' })).toBeNull()
  })

  it('returns null for null payload', () => {
    expect(parseAgentPayload(null)).toBeNull()
  })

  it('returns null for non-object payload', () => {
    expect(parseAgentPayload(42)).toBeNull()
  })

  it('handles missing optional fields gracefully', () => {
    const result = parseAgentPayload({ runId: 'r1' })
    expect(result).not.toBeNull()
    expect(result!.stream).toBeUndefined()
    expect(result!.data).toBeUndefined()
    expect(result!.sessionKey).toBeUndefined()
  })
})

describe('isReasoningStream', () => {
  it('returns true for reasoning-like streams', () => {
    expect(isReasoningStream('thinking')).toBe(true)
    expect(isReasoningStream('reasoning')).toBe(true)
  })

  it('returns true for analysis and trace streams', () => {
    expect(isReasoningStream('analysis')).toBe(true)
    expect(isReasoningStream('trace')).toBe(true)
  })

  it('returns false for non-reasoning streams', () => {
    expect(isReasoningStream('assistant')).toBe(false)
    expect(isReasoningStream('tool')).toBe(false)
    expect(isReasoningStream('lifecycle')).toBe(false)
  })

  it('is case insensitive', () => {
    expect(isReasoningStream('Thinking')).toBe(true)
    expect(isReasoningStream('REASONING')).toBe(true)
  })

  it('returns false for non-reasoning terms that contain a reasoning substring', () => {
    // 'assistant-thinking' contains 'assistant' (non-reasoning) which is checked first
    expect(isReasoningStream('assistant-thinking')).toBe(false)
  })
})
