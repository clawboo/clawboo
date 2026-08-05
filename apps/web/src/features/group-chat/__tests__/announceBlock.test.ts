// The pure derivation behind the group-chat live region. Pinned here rather
// than through the panel because the interesting rules — what stays silent, how
// long a sentence can get, which name is used — are all pure functions of a
// block.

import type { TranscriptEntry } from '@clawboo/protocol'
import { describe, expect, it } from 'vitest'

import type { AssistantBlock, MetaBlock, UserBlock } from '@/features/chat/chatComponents'

import { blockKey, blockTimestamp, describeBlock } from '../announceBlock'

function entry(over: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    entryId: 'e1',
    role: 'assistant',
    kind: 'assistant',
    text: '',
    sessionKey: 'agent:a2:team-t1',
    runId: null,
    source: 'runtime-chat',
    timestampMs: 1000,
    sequenceKey: 1,
    confirmed: true,
    fingerprint: 'f1',
    ...over,
  }
}

function assistant(text: string, over: Partial<AssistantBlock> = {}): AssistantBlock {
  return {
    kind: 'assistant-turn',
    assistant: entry({ text }),
    thinking: [],
    tools: [],
    timestampMs: 1000,
    ...over,
  }
}

const user = (text: string): UserBlock => ({
  kind: 'user',
  entry: entry({ entryId: 'u1', role: 'user', kind: 'user', text }),
})

const meta = (text: string): MetaBlock => ({
  kind: 'meta',
  entry: entry({ entryId: 'm1', role: 'system', kind: 'meta', text }),
})

const nameFor = (id: string | null) => (id === 'a2' ? 'Coder' : 'Agent')
const agentIdOf = (key: string) => key.split(':')[1] ?? null

describe('describeBlock', () => {
  it('names the speaking agent on an assistant turn', () => {
    expect(describeBlock(assistant('Shipped the tagline.'), nameFor, agentIdOf)).toBe(
      'Coder said: Shipped the tagline.',
    )
  })

  it('attributes a user block to the user', () => {
    expect(describeBlock(user('Please review this'), nameFor, agentIdOf)).toBe(
      'You said: Please review this',
    )
  })

  it('reads a meta block verbatim', () => {
    expect(describeBlock(meta('Delivery failed — retrying.'), nameFor, agentIdOf)).toBe(
      'Delivery failed — retrying.',
    )
  })

  // A turn whose only content is orchestration markup renders as BoardTaskCards,
  // not as a message — announcing it would read internal tags aloud.
  it('stays silent on a delegate-only turn', () => {
    const block = assistant('<delegate to="Coder">write the tagline</delegate>')
    expect(describeBlock(block, nameFor, agentIdOf)).toBeNull()
  })

  it('stays silent on a plan-only turn', () => {
    const block = assistant('<plan>1. research\n2. draft</plan>')
    expect(describeBlock(block, nameFor, agentIdOf)).toBeNull()
  })

  // Thinking / tool progress commits as its own prose block later. Announcing
  // the empty shell would read one agent turn out two or three times.
  it('stays silent on a turn with no prose', () => {
    const block = assistant('', { assistant: null, thinking: [entry({ entryId: 'th1' })] })
    expect(describeBlock(block, nameFor, agentIdOf)).toBeNull()
  })

  it('collapses whitespace and truncates a long body', () => {
    const long = 'x'.repeat(300)
    const spoken = describeBlock(assistant(`  a\n\n  b ${long}`), nameFor, agentIdOf)
    expect(spoken).toMatch(/^Coder said: a b x+…$/)
    expect(spoken?.replace('Coder said: ', '')).toHaveLength(181) // 180 + the ellipsis
  })

  it('falls back to a generic name when the agent is unknown', () => {
    const block = assistant('done', { assistant: entry({ text: 'done', sessionKey: 'weird' }) })
    expect(describeBlock(block, nameFor, agentIdOf)).toBe('Agent said: done')
  })

  it('stays silent on an empty user message', () => {
    expect(describeBlock(user('   '), nameFor, agentIdOf)).toBeNull()
  })
})

describe('blockKey', () => {
  it('uses the assistant entry id when present', () => {
    expect(blockKey(assistant('hi'))).toBe('e1')
  })

  it('falls back through thinking, tools, then the timestamp', () => {
    const noAssistant = assistant('', { assistant: null, thinking: [entry({ entryId: 'th1' })] })
    expect(blockKey(noAssistant)).toBe('th1')

    const toolsOnly = assistant('', { assistant: null, tools: [entry({ entryId: 'to1' })] })
    expect(blockKey(toolsOnly)).toBe('to1')

    const bare = assistant('', { assistant: null, timestampMs: 42 })
    expect(blockKey(bare)).toBe('turn:42')
  })

  it('uses the entry id for user and meta blocks', () => {
    expect(blockKey(user('hi'))).toBe('u1')
    expect(blockKey(meta('note'))).toBe('m1')
  })
})

describe('blockTimestamp', () => {
  it('reads the turn timestamp, or the entry timestamp, or 0', () => {
    expect(blockTimestamp(assistant('hi'))).toBe(1000)
    expect(blockTimestamp(user('hi'))).toBe(1000)
    expect(blockTimestamp(assistant('hi', { timestampMs: null }))).toBe(0)
  })
})
