import { describe, it, expect } from 'vitest'
import type { TranscriptEntry } from '@clawboo/protocol'
import { pickLatestActivity } from '../nodes/pickLatestActivity'

// Minimal builder for transcript entries — only fills the fields the helper
// actually inspects (`kind`, `text`). Anything else is filler.
function entry(kind: TranscriptEntry['kind'], text: string, index: number): TranscriptEntry {
  return {
    entryId: `e${index}`,
    role: 'assistant',
    kind,
    text,
    sessionKey: 'agent:a1:main',
    runId: null,
    source: 'runtime-chat',
    timestampMs: 1_000_000 + index,
    sequenceKey: index,
    confirmed: true,
    fingerprint: `fp-${index}`,
  }
}

describe('pickLatestActivity', () => {
  it('returns streaming when streaming text is present, even with empty entries', () => {
    const result = pickLatestActivity('hello mid-stream', [])
    expect(result).toEqual({ kind: 'streaming', text: 'hello mid-stream' })
  })

  it('streaming text wins over a more recent committed assistant entry', () => {
    const entries = [entry('assistant', 'older committed reply', 1)]
    const result = pickLatestActivity('newer streaming chunk', entries)
    expect(result).toEqual({ kind: 'streaming', text: 'newer streaming chunk' })
  })

  it('falls back to latest assistant entry when no streaming text', () => {
    const entries = [
      entry('assistant', 'first reply', 1),
      entry('tool', '[[tool]] some_tool', 2),
      entry('assistant', 'most recent reply', 3),
    ]
    const result = pickLatestActivity(null, entries)
    expect(result).toEqual({ kind: 'assistant', text: 'most recent reply' })
  })

  it('returns the bare tool label, never the [[tool]] protocol line', () => {
    const entries = [
      entry('user', 'do the thing', 1),
      entry('tool', '[[tool]] run_shell\n```json\n{"cmd":"ls"}\n```', 2),
    ]
    const result = pickLatestActivity(null, entries)
    expect(result).toEqual({ kind: 'tool', text: 'run_shell' })
  })

  it('surfaces reasoning: a thinking entry is the newest thing the agent did', () => {
    const entries = [
      entry('assistant', 'older response', 1),
      entry('thinking', 'weighing the two approaches', 2),
    ]
    const result = pickLatestActivity(null, entries)
    expect(result).toEqual({ kind: 'thinking', text: 'weighing the two approaches' })
  })

  it('still skips meta and user entries', () => {
    const entries = [
      entry('assistant', 'older response', 1),
      entry('user', 'a follow-up prompt', 2),
      entry('meta', 'run started', 3),
    ]
    const result = pickLatestActivity(null, entries)
    expect(result).toEqual({ kind: 'assistant', text: 'older response' })
  })

  it('returns null when entries are empty and no streaming text', () => {
    expect(pickLatestActivity(null, [])).toBeNull()
    expect(pickLatestActivity('', [])).toBeNull()
    expect(pickLatestActivity('   ', [])).toBeNull()
    expect(pickLatestActivity(null, null)).toBeNull()
  })
})
