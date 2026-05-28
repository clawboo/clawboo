import { describe, it, expect } from 'vitest'
import type { TranscriptEntry } from '@clawboo/protocol'
import type { AgentState } from '@/stores/fleet'
import { getActivityVerb } from '../agentActivityVerb'

function mkAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 'a1',
    name: 'Agent A',
    status: 'idle',
    sessionKey: 'agent:a1:main',
    model: null,
    createdAt: null,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: 't1',
    execConfig: null,
    ...overrides,
  }
}

function mkEntry(text: string, overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    entryId: 'e1',
    role: 'assistant',
    kind: 'assistant',
    text,
    sessionKey: 'agent:a1:main',
    runId: null,
    source: 'runtime-chat',
    timestampMs: 1000,
    sequenceKey: 1,
    confirmed: true,
    fingerprint: 'f1',
    ...overrides,
  }
}

const NOW = 1_000_000_000

describe('getActivityVerb', () => {
  it('returns Error for error status', () => {
    const agent = mkAgent({ status: 'error' })
    expect(getActivityVerb({ agent, transcripts: null, streamingTexts: null, now: NOW })).toBe(
      'Error',
    )
  })

  it('returns Sleeping for sleeping status', () => {
    const agent = mkAgent({ status: 'sleeping' })
    expect(getActivityVerb({ agent, transcripts: null, streamingTexts: null, now: NOW })).toBe(
      'Sleeping',
    )
  })

  it('returns Streaming reply when streamingText is non-empty without delegate tag', () => {
    const agent = mkAgent({ status: 'running' })
    const streams = new Map([[agent.sessionKey!, 'Hello, working on it…']])
    expect(getActivityVerb({ agent, transcripts: null, streamingTexts: streams, now: NOW })).toBe(
      'Streaming reply',
    )
  })

  it('returns Delegating to @X when streamingText contains a delegate tag', () => {
    const agent = mkAgent({ status: 'running' })
    const streams = new Map([
      [agent.sessionKey!, 'Intro prose <delegate to="@SEO Boo">research</delegate>'],
    ])
    expect(getActivityVerb({ agent, transcripts: null, streamingTexts: streams, now: NOW })).toBe(
      'Delegating to @SEO Boo',
    )
  })

  it('returns Delegating to @X when most-recent committed entry has a delegate tag', () => {
    const agent = mkAgent({ status: 'running' })
    const entries: TranscriptEntry[] = [
      mkEntry('First turn'),
      mkEntry('<delegate to="@Engineering Boo">implement</delegate>'),
    ]
    const ts = new Map([[agent.sessionKey!, entries]])
    expect(getActivityVerb({ agent, transcripts: ts, streamingTexts: null, now: NOW })).toBe(
      'Delegating to @Engineering Boo',
    )
  })

  it('clamps very long delegate target names', () => {
    const agent = mkAgent({ status: 'running' })
    const streams = new Map([
      [agent.sessionKey!, '<delegate to="@SuperLongAgentNameThatGoesForever">do stuff</delegate>'],
    ])
    const result = getActivityVerb({
      agent,
      transcripts: null,
      streamingTexts: streams,
      now: NOW,
    })
    // 16-char clamp + ellipsis sigil; "Delegating to @" prefix is 15 chars.
    expect(result.length).toBeLessThanOrEqual('Delegating to @'.length + 16)
    expect(result.endsWith('…')).toBe(true)
  })

  it('returns Thinking… when running but no stream / no committed delegation', () => {
    const agent = mkAgent({ status: 'running' })
    const entries: TranscriptEntry[] = [mkEntry('No delegation here', { entryId: 'e1' })]
    const ts = new Map([[agent.sessionKey!, entries]])
    expect(getActivityVerb({ agent, transcripts: ts, streamingTexts: null, now: NOW })).toBe(
      'Thinking…',
    )
  })

  it('returns Thinking… when running with no transcripts and no stream', () => {
    const agent = mkAgent({ status: 'running' })
    expect(getActivityVerb({ agent, transcripts: null, streamingTexts: null, now: NOW })).toBe(
      'Thinking…',
    )
  })

  it('only consults the MOST RECENT assistant entry for delegation', () => {
    const agent = mkAgent({ status: 'running' })
    const entries: TranscriptEntry[] = [
      mkEntry('<delegate to="@OldTarget">stale</delegate>'),
      mkEntry('Fresh turn with no delegation'),
    ]
    const ts = new Map([[agent.sessionKey!, entries]])
    expect(getActivityVerb({ agent, transcripts: ts, streamingTexts: null, now: NOW })).toBe(
      'Thinking…',
    )
  })

  it('returns Just done when idle within 60 s of lastSeenAt', () => {
    const agent = mkAgent({ status: 'idle', lastSeenAt: NOW - 30_000 })
    expect(getActivityVerb({ agent, transcripts: null, streamingTexts: null, now: NOW })).toBe(
      'Just done',
    )
  })

  it('returns Idle when idle for longer than 60 s', () => {
    const agent = mkAgent({ status: 'idle', lastSeenAt: NOW - 5 * 60_000 })
    expect(getActivityVerb({ agent, transcripts: null, streamingTexts: null, now: NOW })).toBe(
      'Idle',
    )
  })

  it('returns Idle when lastSeenAt is null', () => {
    const agent = mkAgent({ status: 'idle', lastSeenAt: null })
    expect(getActivityVerb({ agent, transcripts: null, streamingTexts: null, now: NOW })).toBe(
      'Idle',
    )
  })

  it('handles agents with no sessionKey gracefully', () => {
    const agent = mkAgent({ status: 'running', sessionKey: null })
    const streams = new Map([['agent:other:main', 'some text']])
    expect(
      getActivityVerb({
        agent,
        transcripts: null,
        streamingTexts: streams,
        now: NOW,
      }),
    ).toBe('Thinking…')
  })
})
