/**
 * buildDelegationLinkages — pure helper that pairs `<delegate>` source blocks
 * with the next eligible target reply in a merged team transcript.
 *
 * Run with `pnpm --filter @clawboo/web test -- --run features/group-chat/__tests__/buildDelegationLinkages.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import type { TranscriptEntry } from '@clawboo/protocol'
import { groupEntriesToBlocks } from '@/features/chat/chatComponents'
import { buildDelegationLinkages } from '../buildDelegationLinkages'
import { nextSeq } from '@/lib/sequenceKey'

// ── Test entry factory ───────────────────────────────────────────────────────

let __ts = 1_700_000_000_000
function nextTs(): number {
  __ts += 1000
  return __ts
}

function makeAssistantEntry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    entryId: crypto.randomUUID(),
    runId: 'run-' + Math.random().toString(36).slice(2, 9),
    sessionKey: 'agent:a1:team:t1',
    kind: 'assistant',
    role: 'assistant',
    text: 'hello',
    source: 'runtime-chat',
    timestampMs: nextTs(),
    sequenceKey: nextSeq(),
    confirmed: true,
    fingerprint: crypto.randomUUID(),
    ...overrides,
  } as TranscriptEntry
}

function teamSk(agentId: string, teamId = 't1'): string {
  return `agent:${agentId}:team:${teamId}`
}

const participants = [
  { id: 'bz', name: 'Boo Zero' },
  { id: 'eng', name: 'Engineer Boo' },
  { id: 'des', name: 'Designer Boo' },
]

function build(mergedEntries: TranscriptEntry[]) {
  const blocks = groupEntriesToBlocks(mergedEntries)
  return buildDelegationLinkages({
    blocks,
    mergedEntries,
    teamId: 't1',
    participants,
  })
}

// ─────────────────────────────────────────────────────────────────────────────

describe('buildDelegationLinkages — single delegation', () => {
  it('claims the first eligible target reply after the source entry', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'Working on it. <delegate to="@Engineer Boo">Build a TL;DR</delegate>',
    })
    const reply = makeAssistantEntry({
      sessionKey: teamSk('eng'),
      runId: 'run-eng-1',
      text: 'Voice AI takes audio input...',
    })
    const result = build([source, reply])

    expect(result.linkagesByDelegationId.size).toBe(1)
    const linkage = [...result.linkagesByDelegationId.values()][0]!
    expect(linkage.targetAgentId).toBe('eng')
    expect(linkage.targetAgentName).toBe('Engineer Boo')
    expect(linkage.sourceAgentId).toBe('bz')
    expect(linkage.linkedEntries).toEqual([reply])
    expect(linkage.isPending).toBe(false)
    expect(result.claimedEntries.has(reply.entryId)).toBe(true)
  })

  it('produces a deterministic delegationId from sourceEntryId + blockStart', () => {
    const text = 'Hi. <delegate to="@Engineer Boo">first</delegate>'
    const source = makeAssistantEntry({ sessionKey: teamSk('bz'), text })
    const reply = makeAssistantEntry({ sessionKey: teamSk('eng'), text: 'done' })
    const expectedBlockStart = text.indexOf('<delegate')

    const result = build([source, reply])
    const id = `${source.entryId}:${expectedBlockStart}`
    expect(result.linkagesByDelegationId.has(id)).toBe(true)
  })

  it('returns isPending=true with empty linkedEntries when the target has not replied yet', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '<delegate to="@Engineer Boo">do thing</delegate>',
    })
    const result = build([source])
    expect(result.linkagesByDelegationId.size).toBe(1)
    const linkage = [...result.linkagesByDelegationId.values()][0]!
    expect(linkage.isPending).toBe(true)
    expect(linkage.linkedEntries).toEqual([])
    expect(result.streamingOwnerByTargetSessionKey.get(teamSk('eng'))).toBe(linkage.delegationId)
  })
})

describe('buildDelegationLinkages — multiple delegations', () => {
  it('FIFO-claims for two delegations to the same target from the same source turn', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '<delegate to="@Engineer Boo">first</delegate> <delegate to="@Engineer Boo">second</delegate>',
    })
    const reply1 = makeAssistantEntry({
      sessionKey: teamSk('eng'),
      runId: 'run-eng-A',
      text: 'reply to first',
    })
    const reply2 = makeAssistantEntry({
      sessionKey: teamSk('eng'),
      runId: 'run-eng-B',
      text: 'reply to second',
    })

    const result = build([source, reply1, reply2])
    expect(result.linkagesByDelegationId.size).toBe(2)
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(2)
    // Source-text order — first block claims reply1, second claims reply2.
    expect(linkages[0]!.task).toBe('first')
    expect(linkages[0]!.linkedEntries).toEqual([reply1])
    expect(linkages[1]!.task).toBe('second')
    expect(linkages[1]!.linkedEntries).toEqual([reply2])
  })

  it('routes delegations to different targets independently', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '<delegate to="@Engineer Boo">backend</delegate> <delegate to="@Designer Boo">UI</delegate>',
    })
    const replyEng = makeAssistantEntry({
      sessionKey: teamSk('eng'),
      runId: 'run-eng',
      text: 'backend ok',
    })
    const replyDes = makeAssistantEntry({
      sessionKey: teamSk('des'),
      runId: 'run-des',
      text: 'UI ok',
    })

    const result = build([source, replyEng, replyDes])
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(2)
    expect(linkages[0]!.targetAgentId).toBe('eng')
    expect(linkages[0]!.linkedEntries).toEqual([replyEng])
    expect(linkages[1]!.targetAgentId).toBe('des')
    expect(linkages[1]!.linkedEntries).toEqual([replyDes])
  })
})

describe('buildDelegationLinkages — accretion + multi-entry replies', () => {
  it('accretes thinking + tool + assistant entries sharing the target reply runId', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '<delegate to="@Engineer Boo">work</delegate>',
    })
    const thinking = makeAssistantEntry({
      sessionKey: teamSk('eng'),
      runId: 'run-X',
      kind: 'thinking',
      text: 'pondering...',
    } as Partial<TranscriptEntry>)
    const tool = makeAssistantEntry({
      sessionKey: teamSk('eng'),
      runId: 'run-X',
      kind: 'tool',
      text: '[[tool]] read\nfoo',
    } as Partial<TranscriptEntry>)
    const reply = makeAssistantEntry({
      sessionKey: teamSk('eng'),
      runId: 'run-X',
      text: 'final answer',
    })

    const result = build([source, thinking, tool, reply])
    const linkage = [...result.linkagesByDelegationId.values()][0]!
    expect(linkage.linkedEntries.map((e) => e.entryId).sort()).toEqual(
      [thinking.entryId, tool.entryId, reply.entryId].sort(),
    )
    expect(result.claimedEntries.size).toBe(3)
  })
})

describe('buildDelegationLinkages — filters and guards', () => {
  it('skips delegations whose source entry is a relay message', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '[Team Update] — relayed summary\n<delegate to="@Engineer Boo">x</delegate>',
    })
    const reply = makeAssistantEntry({ sessionKey: teamSk('eng'), text: 'reply' })
    const result = build([source, reply])
    expect(result.linkagesByDelegationId.size).toBe(0)
    expect(result.claimedEntries.size).toBe(0)
  })

  it('skips self-delegations', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '<delegate to="@Boo Zero">work for myself</delegate>',
    })
    const result = build([source])
    expect(result.linkagesByDelegationId.size).toBe(0)
  })

  it('skips delegations with an unknown target', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '<delegate to="@Nonexistent Boo">whatever</delegate>',
    })
    const result = build([source])
    expect(result.linkagesByDelegationId.size).toBe(0)
  })

  it('skips delegations with an empty task body', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '<delegate to="@Engineer Boo">   </delegate>',
    })
    const result = build([source])
    expect(result.linkagesByDelegationId.size).toBe(0)
  })

  it('returns empty when there are no blocks or no entries', () => {
    expect(build([]).linkagesByDelegationId.size).toBe(0)
  })
})

describe('buildDelegationLinkages — chain A→B→C (recursive nesting)', () => {
  it('builds linkages for both hops independently — each source entry maps to its own delegation', () => {
    // Boo Zero delegates to Engineer Boo; Engineer Boo's reply contains a
    // delegation to Designer Boo. We expect two linkages — one keyed by
    // Boo Zero's source entry, one keyed by Engineer Boo's reply entry.
    const sourceBz = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '<delegate to="@Engineer Boo">build</delegate>',
    })
    const replyEng = makeAssistantEntry({
      sessionKey: teamSk('eng'),
      runId: 'run-eng',
      text: 'I will. <delegate to="@Designer Boo">need a mock</delegate>',
    })
    const replyDes = makeAssistantEntry({
      sessionKey: teamSk('des'),
      runId: 'run-des',
      text: 'mock attached',
    })

    const result = build([sourceBz, replyEng, replyDes])
    expect(result.linkagesByDelegationId.size).toBe(2)
    expect(result.linkagesBySourceEntry.get(sourceBz.entryId)).toHaveLength(1)
    expect(result.linkagesBySourceEntry.get(replyEng.entryId)).toHaveLength(1)
    // Engineer's reply is claimed by Boo Zero's delegation; Designer's reply
    // is claimed by Engineer's nested delegation. All three are claimed.
    expect(result.claimedEntries.has(replyEng.entryId)).toBe(true)
    expect(result.claimedEntries.has(replyDes.entryId)).toBe(true)
  })
})

describe('buildDelegationLinkages — streaming owner', () => {
  it('only the first pending delegation per target owns the streaming card', () => {
    // Two delegations to Engineer Boo; neither has a reply. First one wins
    // the streaming-owner slot.
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '<delegate to="@Engineer Boo">first</delegate> <delegate to="@Engineer Boo">second</delegate>',
    })
    const result = build([source])
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(2)
    expect(result.streamingOwnerByTargetSessionKey.get(teamSk('eng'))).toBe(
      linkages[0]!.delegationId,
    )
  })

  it('does not set a streaming owner once the latest delegation has a reply', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '<delegate to="@Engineer Boo">do it</delegate>',
    })
    const reply = makeAssistantEntry({ sessionKey: teamSk('eng'), text: 'done' })
    const result = build([source, reply])
    expect(result.streamingOwnerByTargetSessionKey.get(teamSk('eng'))).toBeUndefined()
  })
})

describe('buildDelegationLinkages — idempotency + invariants', () => {
  it('idempotent: calling twice with the same inputs returns equivalent output', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '<delegate to="@Engineer Boo">x</delegate>',
    })
    const reply = makeAssistantEntry({ sessionKey: teamSk('eng'), text: 'ok' })
    const a = build([source, reply])
    const b = build([source, reply])
    expect([...a.linkagesByDelegationId.keys()]).toEqual([...b.linkagesByDelegationId.keys()])
    expect(a.claimedEntries.size).toBe(b.claimedEntries.size)
  })

  it('no entry is claimed by more than one delegation (single-claim invariant)', () => {
    // Two delegations to the SAME target with only ONE reply available —
    // only the first delegation should claim the reply, the second stays
    // pending.
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '<delegate to="@Engineer Boo">first</delegate> <delegate to="@Engineer Boo">second</delegate>',
    })
    const reply = makeAssistantEntry({
      sessionKey: teamSk('eng'),
      runId: 'run-only',
      text: 'only reply',
    })
    const result = build([source, reply])
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages[0]!.linkedEntries).toEqual([reply])
    expect(linkages[1]!.linkedEntries).toEqual([])
    expect(linkages[1]!.isPending).toBe(true)
    expect(result.claimedEntries.size).toBe(1)
  })
})
