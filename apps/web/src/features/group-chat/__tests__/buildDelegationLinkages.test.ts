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

// Round 6: `sessions_send` tool calls render as DelegationCards directly. The
// LLM often skips structured `<delegate>` tags and calls OpenClaw's
// `sessions_send` Gateway tool instead — that call IS visible as a tool
// entry in the leader's transcript (kind: 'tool', text: '[[tool]] sessions_send …').
// The renderer-side scan converts each such call into a structured linkage
// using the EXACT JSON params (`to`, `message`) — no prose heuristics.

function makeToolCallEntry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    entryId: crypto.randomUUID(),
    runId: 'run-' + Math.random().toString(36).slice(2, 9),
    sessionKey: 'agent:bz:team:t1',
    kind: 'tool',
    role: 'tool',
    text: '',
    source: 'runtime-chat',
    timestampMs: nextTs(),
    sequenceKey: nextSeq(),
    confirmed: true,
    fingerprint: crypto.randomUUID(),
    ...overrides,
  } as TranscriptEntry
}

/**
 * Build a `[[tool]] sessions_send …` line in the shape `@clawboo/protocol`'s
 * `formatToolCallMarkdown` produces. OpenClaw's actual `sessions_send`
 * schema is `{ sessionKey?, label?, agentId?, message }` — the caller
 * supplies AT LEAST ONE routing identifier plus the message body. We
 * provide a helper for each common form so tests can exercise the
 * resolver paths independently.
 */
function sessionsSendToolText(
  params: { sessionKey?: string; label?: string; agentId?: string; message: string },
  callId = 'abc',
): string {
  return `[[tool]] sessions_send (${callId})\n\`\`\`json\n${JSON.stringify(params)}\n\`\`\``
}

describe('buildDelegationLinkages — sessions_send tool-call path (Round 6)', () => {
  it('resolves a sessions_send call using `label` (agent display name)', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'Let me have the team handle this.',
    })
    // Most common form in practice: the LLM uses the agent's display name.
    const toolCall = makeToolCallEntry({
      runId: source.runId,
      text: sessionsSendToolText({ label: 'Engineer Boo', message: 'Build a TL;DR for voice AI' }),
    })
    const reply = makeAssistantEntry({
      sessionKey: teamSk('eng'),
      runId: 'run-eng-1',
      text: 'Voice AI takes audio input...',
    })
    const result = build([source, toolCall, reply])
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(1)
    expect(linkages[0]!.source).toBe('sessions-send')
    expect(linkages[0]!.targetAgentId).toBe('eng')
    expect(linkages[0]!.targetAgentName).toBe('Engineer Boo')
    expect(linkages[0]!.task).toBe('Build a TL;DR for voice AI')
    expect(linkages[0]!.linkedEntries).toEqual([reply])
    expect(result.claimedEntries.has(toolCall.entryId)).toBe(true)
    expect(result.claimedEntries.has(reply.entryId)).toBe(true)
  })

  it('resolves a sessions_send call using `agentId` (direct id)', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'Routing by id.',
    })
    const toolCall = makeToolCallEntry({
      runId: source.runId,
      text: sessionsSendToolText({ agentId: 'eng', message: 'do the thing' }),
    })
    const reply = makeAssistantEntry({
      sessionKey: teamSk('eng'),
      runId: 'run-eng-id',
      text: 'done',
    })
    const result = build([source, toolCall, reply])
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(1)
    expect(linkages[0]!.targetAgentId).toBe('eng')
  })

  it('resolves a sessions_send call using `sessionKey` (parses agent:<id>:<session>)', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'Routing by sessionKey.',
    })
    const toolCall = makeToolCallEntry({
      runId: source.runId,
      text: sessionsSendToolText({ sessionKey: 'agent:des:main', message: 'design something' }),
    })
    const reply = makeAssistantEntry({
      sessionKey: teamSk('des'),
      runId: 'run-des-sk',
      text: 'design draft',
    })
    const result = build([source, toolCall, reply])
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(1)
    expect(linkages[0]!.targetAgentId).toBe('des')
    expect(linkages[0]!.task).toBe('design something')
  })

  it('skips sessions_send calls whose identifier resolves to no participant', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'Misrouted call.',
    })
    const toolCall = makeToolCallEntry({
      runId: source.runId,
      text: sessionsSendToolText({ agentId: 'unknown-agent', message: 'this should not link' }),
    })
    const result = build([source, toolCall])
    expect(result.linkagesByDelegationId.size).toBe(0)
    expect(result.claimedEntries.has(toolCall.entryId)).toBe(false)
  })

  it('skips sessions_send calls that target the source agent itself', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'Self-loop, ignore.',
    })
    const toolCall = makeToolCallEntry({
      runId: source.runId,
      text: sessionsSendToolText({ agentId: 'bz', message: 'I am calling myself' }),
    })
    const result = build([source, toolCall])
    expect(result.linkagesByDelegationId.size).toBe(0)
    expect(result.claimedEntries.has(toolCall.entryId)).toBe(false)
  })

  it('coexists with explicit <delegate> tags on the same source — both link', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'Mixed routing. <delegate to="@Engineer Boo">tag-routed task</delegate>',
    })
    const toolCall = makeToolCallEntry({
      runId: source.runId,
      text: sessionsSendToolText({ label: 'Designer Boo', message: 'tool-routed task' }),
    })
    const engReply = makeAssistantEntry({
      sessionKey: teamSk('eng'),
      runId: 'run-eng',
      text: 'engineer reply',
    })
    const desReply = makeAssistantEntry({
      sessionKey: teamSk('des'),
      runId: 'run-des',
      text: 'designer reply',
    })
    const result = build([source, toolCall, engReply, desReply])
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(2)
    const bySource = linkages.reduce<Record<string, (typeof linkages)[number]>>((acc, l) => {
      acc[l.source] = l
      return acc
    }, {})
    expect(bySource['delegate-tag']?.targetAgentId).toBe('eng')
    expect(bySource['delegate-tag']?.task).toBe('tag-routed task')
    expect(bySource['sessions-send']?.targetAgentId).toBe('des')
    expect(bySource['sessions-send']?.task).toBe('tool-routed task')
  })

  it('gracefully ignores sessions_send tool entries with malformed JSON', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'Routing.',
    })
    const toolCall = makeToolCallEntry({
      runId: source.runId,
      text: '[[tool]] sessions_send\n```json\n{ not valid json\n```',
    })
    const result = build([source, toolCall])
    expect(result.linkagesByDelegationId.size).toBe(0)
    expect(result.claimedEntries.has(toolCall.entryId)).toBe(false)
  })

  it('marks the linkage pending when the target has not responded yet', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'Routing.',
    })
    const toolCall = makeToolCallEntry({
      runId: source.runId,
      text: sessionsSendToolText({ label: 'Engineer Boo', message: 'work in progress' }),
    })
    const result = build([source, toolCall])
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(1)
    expect(linkages[0]!.isPending).toBe(true)
    expect(linkages[0]!.linkedEntries).toEqual([])
    expect(result.claimedEntries.has(toolCall.entryId)).toBe(true)
  })
})

// Round 7: Path 3 — Clawboo's own routing events become DelegationCards.
// When the LLM doesn't emit `<delegate>` tags OR `sessions_send` calls but
// Clawboo's orchestration STILL routes work to specialists (via the
// `detectDelegations` fallback regex OR `flushRelayBatch`), the recorded
// dispatch in the chat store becomes the synthesis source. Cards reflect
// actual Clawboo routing, not just the LLM's preferred emission format.

import type { ClawbooDispatch } from '@/stores/chat'

function makeDispatch(
  overrides: Partial<ClawbooDispatch> & {
    sourceEntryId: string
    targetAgentId: string
    targetAgentName: string
  },
): ClawbooDispatch {
  return {
    dispatchId: 'disp-' + Math.random().toString(36).slice(2, 9),
    sourceAgentId: 'bz',
    taskBody: 'do the thing',
    origin: 'clawboo-relay',
    sequenceKey: nextSeq(),
    timestampMs: nextTs(),
    teamId: 't1',
    ...overrides,
  } as ClawbooDispatch
}

function buildWithDispatches(
  mergedEntries: TranscriptEntry[],
  dispatches: Map<string, ClawbooDispatch[]>,
) {
  const blocks = groupEntriesToBlocks(mergedEntries)
  return buildDelegationLinkages({
    blocks,
    mergedEntries,
    teamId: 't1',
    participants,
    clawbooDispatches: dispatches,
  })
}

describe('buildDelegationLinkages — Path 3 Clawboo-dispatch (Round 7)', () => {
  it('synthesizes a relay-batch linkage when Clawboo routed without an explicit tag', () => {
    // Order matters: nextSeq() is monotonic; the dispatch needs a
    // sequenceKey LOWER than the reply for `findTargetResponse` to claim
    // it. Real production flow guarantees this (the dispatch is recorded
    // BEFORE the target's reply commits). Mirror that ordering here.
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'Here is a markdown table summarizing what the team would say...',
    })
    const dispatch = makeDispatch({
      sourceEntryId: source.entryId,
      targetAgentId: 'eng',
      targetAgentName: 'Engineer Boo',
      origin: 'relay-batch',
      taskBody: 'Relayed summary of leader response',
    })
    const reply = makeAssistantEntry({
      sessionKey: teamSk('eng'),
      runId: 'run-eng-relay',
      text: '__skipped__',
    })
    const dispatches = new Map([[`t1:${source.entryId}`, [dispatch]]])
    const result = buildWithDispatches([source, reply], dispatches)
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(1)
    expect(linkages[0]!.source).toBe('clawboo-relay')
    expect(linkages[0]!.targetAgentId).toBe('eng')
    expect(linkages[0]!.targetAgentName).toBe('Engineer Boo')
    expect(linkages[0]!.task).toBe('Relayed summary of leader response')
    // Note: reply text is `__skipped__` — `findTargetResponse` doesn't
    // filter by content (that's `shouldDropAssistantTurn`'s job at render
    // time, applied to the source not the target).
    expect(linkages[0]!.linkedEntries).toEqual([reply])
  })

  it('synthesizes a dispatch-delegation linkage when the fallback regex routed', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '@Engineer Boo, please look at this',
    })
    const dispatch = makeDispatch({
      sourceEntryId: source.entryId,
      targetAgentId: 'eng',
      targetAgentName: 'Engineer Boo',
      origin: 'dispatch-delegation',
      taskBody: 'please look at this',
    })
    const dispatches = new Map([[`t1:${source.entryId}`, [dispatch]]])
    const result = buildWithDispatches([source], dispatches)
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(1)
    expect(linkages[0]!.source).toBe('clawboo-dispatch')
    expect(linkages[0]!.isPending).toBe(true)
  })

  it('skips Path 3 when Path 1 (<delegate>) already linked the same target', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '<delegate to="@Engineer Boo">explicit task</delegate>',
    })
    const reply = makeAssistantEntry({
      sessionKey: teamSk('eng'),
      runId: 'run-eng-explicit',
      text: 'engineer reply',
    })
    // A Path 3 dispatch ALSO exists for the same target.
    const dispatch = makeDispatch({
      sourceEntryId: source.entryId,
      targetAgentId: 'eng',
      targetAgentName: 'Engineer Boo',
      origin: 'dispatch-delegation',
      taskBody: 'this task should be ignored',
    })
    const dispatches = new Map([[`t1:${source.entryId}`, [dispatch]]])
    const result = buildWithDispatches([source, reply], dispatches)
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(1)
    expect(linkages[0]!.source).toBe('delegate-tag')
    expect(linkages[0]!.task).toBe('explicit task')
  })

  it('skips Path 3 when Path 2 (sessions_send) already linked the same target', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'Calling the tool.',
    })
    const toolCall = makeToolCallEntry({
      runId: source.runId,
      text: sessionsSendToolText({ label: 'Engineer Boo', message: 'tool-routed task' }),
    })
    const dispatch = makeDispatch({
      sourceEntryId: source.entryId,
      targetAgentId: 'eng',
      targetAgentName: 'Engineer Boo',
      origin: 'dispatch-delegation',
      taskBody: 'duplicate path 3 should be ignored',
    })
    const dispatches = new Map([[`t1:${source.entryId}`, [dispatch]]])
    const result = buildWithDispatches([source, toolCall], dispatches)
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(1)
    expect(linkages[0]!.source).toBe('sessions-send')
    expect(linkages[0]!.task).toBe('tool-routed task')
  })

  it('marks Path 3 linkage pending when no target reply exists yet', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'Routing.',
    })
    const dispatch = makeDispatch({
      sourceEntryId: source.entryId,
      targetAgentId: 'eng',
      targetAgentName: 'Engineer Boo',
      origin: 'relay-batch',
    })
    const dispatches = new Map([[`t1:${source.entryId}`, [dispatch]]])
    const result = buildWithDispatches([source], dispatches)
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(1)
    expect(linkages[0]!.isPending).toBe(true)
    expect(linkages[0]!.linkedEntries).toEqual([])
  })

  it('skips Path 3 dispatches whose targetAgentId is not in participants', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'Routing to ghost.',
    })
    const dispatch = makeDispatch({
      sourceEntryId: source.entryId,
      targetAgentId: 'ghost-agent',
      targetAgentName: 'Ghost Boo',
      origin: 'relay-batch',
    })
    const dispatches = new Map([[`t1:${source.entryId}`, [dispatch]]])
    const result = buildWithDispatches([source], dispatches)
    expect(result.linkagesByDelegationId.size).toBe(0)
  })

  it('skips Path 3 entirely when no clawbooDispatches map is supplied (1:1 chat path)', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'Just talking.',
    })
    const blocks = groupEntriesToBlocks([source])
    const result = buildDelegationLinkages({
      blocks,
      mergedEntries: [source],
      teamId: 't1',
      participants,
      // clawbooDispatches omitted on purpose.
    })
    expect(result.linkagesByDelegationId.size).toBe(0)
  })
})

// Round 7B: post-reload stale-entry filter. `sequenceKey` is process-local
// (resets on page reload) while transcript data persists in SQLite. After a
// reload, hydrated entries from prior sessions can have HIGHER sequenceKeys
// than freshly-emitted entries — which is why the linkage scan filters by
// `timestampMs` as the primary "after-source" check, not sequenceKey.

describe('findTargetResponse (via buildDelegationLinkages) — post-reload stale-entry filter', () => {
  it('does NOT pick a stale target entry whose sequenceKey is higher but timestamp is older', () => {
    // Simulate post-reload state: an old hydrated entry has sequenceKey=999
    // (carried over from a prior session) but its timestampMs is OLDER than
    // the current source. The fresh response has a lower sequenceKey (counter
    // restarted at 0 this session) but a newer timestamp. Round 7B's
    // timestamp-primary filter must pick the FRESH one.
    const staleTimestamp = 1_700_000_000_000 // older
    const freshTimestamp = 1_700_000_005_000 // newer (5s later)

    const sourceTs = 1_700_000_003_000 // between stale and fresh
    const source: TranscriptEntry = {
      entryId: 'source-current',
      runId: 'run-current',
      sessionKey: teamSk('bz'),
      kind: 'assistant',
      role: 'assistant',
      text: '<delegate to="@Engineer Boo">do a fresh thing</delegate>',
      source: 'runtime-chat',
      timestampMs: sourceTs,
      sequenceKey: 1, // low — current session, just reset
      confirmed: true,
      fingerprint: 'fp-source',
    } as TranscriptEntry

    const staleReply: TranscriptEntry = {
      entryId: 'reply-stale',
      runId: 'run-stale',
      sessionKey: teamSk('eng'),
      kind: 'assistant',
      role: 'assistant',
      text: "Hey! I'm Engineer Boo, and I specialize in ...",
      source: 'runtime-chat',
      timestampMs: staleTimestamp, // BEFORE source
      sequenceKey: 999, // hydrated with high seqkey from prior session
      confirmed: true,
      fingerprint: 'fp-stale',
    } as TranscriptEntry

    const freshReply: TranscriptEntry = {
      entryId: 'reply-fresh',
      runId: 'run-fresh',
      sessionKey: teamSk('eng'),
      kind: 'assistant',
      role: 'assistant',
      text: 'Here is the fresh substantive answer from this session.',
      source: 'runtime-chat',
      timestampMs: freshTimestamp, // AFTER source
      sequenceKey: 2, // current session
      confirmed: true,
      fingerprint: 'fp-fresh',
    } as TranscriptEntry

    const result = build([source, staleReply, freshReply])
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(1)
    expect(linkages[0]!.linkedEntries).toEqual([freshReply])
    // Stale entry must NOT be claimed.
    expect(result.claimedEntries.has(staleReply.entryId)).toBe(false)
  })
})

// Round 9: Path 3 propagates `planId` + `planStepIndex` from
// `ClawbooDispatch` onto the synthesized `DelegationLinkage`. The renderer
// uses these fields to group plan-step linkages under one `<PlanCard>`.

describe('buildDelegationLinkages — Path 3 plan provenance (Round 9)', () => {
  it('propagates planId + planStepIndex onto the linkage when dispatch carries them', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '<plan><step to="@Engineer Boo">build it</step></plan>',
    })
    const dispatch = makeDispatch({
      sourceEntryId: source.entryId,
      targetAgentId: 'eng',
      targetAgentName: 'Engineer Boo',
      origin: 'dispatch-delegation',
      planId: 'plan-abc',
      planStepIndex: 0,
    })
    const dispatches = new Map([[`t1:${source.entryId}`, [dispatch]]])
    const result = buildWithDispatches([source], dispatches)
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(1)
    expect(linkages[0]!.planId).toBe('plan-abc')
    expect(linkages[0]!.planStepIndex).toBe(0)
    expect(linkages[0]!.source).toBe('clawboo-dispatch')
  })

  it('non-plan dispatches keep planId / planStepIndex null', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'normal prose, no plan',
    })
    const dispatch = makeDispatch({
      sourceEntryId: source.entryId,
      targetAgentId: 'eng',
      targetAgentName: 'Engineer Boo',
      origin: 'dispatch-delegation',
      // planId / planStepIndex deliberately omitted.
    })
    const dispatches = new Map([[`t1:${source.entryId}`, [dispatch]]])
    const result = buildWithDispatches([source], dispatches)
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(1)
    expect(linkages[0]!.planId).toBeNull()
    expect(linkages[0]!.planStepIndex).toBeNull()
  })

  it('groups three plan-step linkages under one planId in source-entry order', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '<plan>...</plan>',
    })
    const planId = 'plan-xyz'
    const dispatches = new Map([
      [
        `t1:${source.entryId}`,
        [
          makeDispatch({
            sourceEntryId: source.entryId,
            targetAgentId: 'eng',
            targetAgentName: 'Engineer Boo',
            origin: 'dispatch-delegation',
            planId,
            planStepIndex: 0,
          }),
          makeDispatch({
            sourceEntryId: source.entryId,
            targetAgentId: 'des',
            targetAgentName: 'Designer Boo',
            origin: 'dispatch-delegation',
            planId,
            planStepIndex: 1,
          }),
        ],
      ],
    ])
    const result = buildWithDispatches([source], dispatches)
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(2)
    // All linkages share the same planId.
    expect(linkages.every((l) => l.planId === planId)).toBe(true)
    // Step indices preserved.
    expect(linkages.map((l) => l.planStepIndex)).toEqual([0, 1])
  })
})

// Round 10: Path 1 attributes `workstreamId` when the source emits ≥2 valid
// `<delegate>` blocks without a `<plan>` wrapper. The renderer groups the
// resulting linkages under a single `<WorkstreamCard>`.

describe('buildDelegationLinkages — Path 1 workstream attribution (Round 10)', () => {
  it('attributes a single workstreamId + sequential targetIndex to ≥2 sibling <delegate> linkages', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text:
        'Firing 3 parallel workstreams.\n\n' +
        '<delegate to="@Engineer Boo">research market</delegate>\n\n' +
        '<delegate to="@Designer Boo">research features</delegate>\n\n' +
        '<delegate to="@Boo Zero">research sentiment</delegate>',
    })
    const result = build([source])
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    // 3 valid linkages (Boo Zero is in participants but is the source — self-
    // delegations are filtered out; so only Engineer + Designer remain).
    expect(linkages).toHaveLength(2)
    const expectedWsId = `t1:${source.entryId}:workstreams`
    expect(linkages.every((l) => l.workstreamId === expectedWsId)).toBe(true)
    expect(linkages.map((l) => l.workstreamTargetIndex)).toEqual([0, 1])
    expect(linkages.every((l) => l.source === 'delegate-tag')).toBe(true)
  })

  it('does NOT attribute workstreamId for a single <delegate> (N<2)', () => {
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'Single delegation.\n\n<delegate to="@Engineer Boo">do it</delegate>',
    })
    const result = build([source])
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(1)
    expect(linkages[0]!.workstreamId).toBeNull()
    expect(linkages[0]!.workstreamTargetIndex).toBeNull()
  })

  it('does NOT attribute workstreamId when a <plan> block is on the same source (plans take precedence)', () => {
    // Two `<delegate>` blocks + one `<plan>` block on the same source.
    // The plan gate short-circuits workstream minting; both delegations
    // render as standalone DelegationCards under the leader's prose.
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text:
        '<plan><step to="@Engineer Boo">step 1</step><step to="@Designer Boo">step 2</step></plan>\n\n' +
        '<delegate to="@Engineer Boo">also do this</delegate>\n\n' +
        '<delegate to="@Designer Boo">and this</delegate>',
    })
    const result = build([source])
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    // Both delegations exist as linkages (with `source: 'delegate-tag'`),
    // but neither carries a workstreamId because `findPlanBlocks(text).length > 0`.
    expect(linkages).toHaveLength(2)
    expect(linkages.every((l) => l.workstreamId === null)).toBe(true)
    expect(linkages.every((l) => l.workstreamTargetIndex === null)).toBe(true)
  })
})

// Round 13: Path 4 — implicit fan-out workstreams synthesized from
// `pendingWorkstreams` map. When the leader emits pure fan-out prose
// WITHOUT structured tags, the orchestration hook mints a workstream
// record; Path 4 turns those into renderable DelegationLinkages.

describe('buildDelegationLinkages — Path 4 implicit fan-out (Round 13)', () => {
  function buildWithPendingWs(
    mergedEntries: TranscriptEntry[],
    pendingWorkstreams: Map<string, import('@/stores/chat').PendingWorkstreams>,
  ) {
    const blocks = groupEntriesToBlocks(mergedEntries)
    return buildDelegationLinkages({
      blocks,
      mergedEntries,
      teamId: 't1',
      participants,
      pendingWorkstreams,
    })
  }

  it('synthesizes linkages for an :implicit-fanout workstream when no Path 1 tags exist', () => {
    // Leader emits prose only — no <delegate> tags. Orchestration minted
    // an implicit workstream with 2 targets. Path 4 should produce 2
    // linkages for the source.
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: "I'll ask all teammates for their take. Got responses from all three.",
    })
    const replyEng = makeAssistantEntry({
      sessionKey: teamSk('eng'),
      text: 'Engineering says: build it.',
    })
    const replyDes = makeAssistantEntry({
      sessionKey: teamSk('des'),
      text: 'Designer says: make it pretty.',
    })
    const wsId = `t1:${source.entryId}:implicit-fanout`
    const pendingWs = new Map<string, import('@/stores/chat').PendingWorkstreams>([
      [
        wsId,
        {
          workstreamId: wsId,
          sourceEntryId: source.entryId,
          sourceAgentId: 'bz',
          teamId: 't1',
          targets: [
            {
              targetAgentId: 'eng',
              targetAgentName: 'Engineer Boo',
              task: 'user question text',
              output: null,
              resolvedEntryId: null,
            },
            {
              targetAgentId: 'des',
              targetAgentName: 'Designer Boo',
              task: 'user question text',
              output: null,
              resolvedEntryId: null,
            },
          ],
          timestampMs: source.timestampMs! - 1, // workstream minted at-or-before the source's commit
        },
      ],
    ])
    const result = buildWithPendingWs([source, replyEng, replyDes], pendingWs)
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(2)
    expect(linkages.every((l) => l.source === 'clawboo-dispatch')).toBe(true)
    expect(linkages.every((l) => l.workstreamId === wsId)).toBe(true)
    expect(linkages.map((l) => l.workstreamTargetIndex)).toEqual([0, 1])
    // Both replies should be claimed via findTargetResponse.
    expect(linkages[0]!.linkedEntries).toEqual([replyEng])
    expect(linkages[1]!.linkedEntries).toEqual([replyDes])
    expect(linkages.every((l) => !l.isPending)).toBe(true)
  })

  it('SKIPS Path 4 when Path 1 already produced linkages on the same source', () => {
    // The leader's response has BOTH fan-out prose AND a structured
    // <delegate> tag. Path 1 wins; Path 4 must not double-mint.
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'I\'ll ask all teammates. <delegate to="@Engineer Boo">just you</delegate>',
    })
    const reply = makeAssistantEntry({ sessionKey: teamSk('eng'), text: 'done' })
    const wsId = `t1:${source.entryId}:implicit-fanout`
    const pendingWs = new Map<string, import('@/stores/chat').PendingWorkstreams>([
      [
        wsId,
        {
          workstreamId: wsId,
          sourceEntryId: source.entryId,
          sourceAgentId: 'bz',
          teamId: 't1',
          targets: [
            {
              targetAgentId: 'eng',
              targetAgentName: 'Engineer Boo',
              task: 'should not appear',
              output: null,
              resolvedEntryId: null,
            },
            {
              targetAgentId: 'des',
              targetAgentName: 'Designer Boo',
              task: 'should not appear',
              output: null,
              resolvedEntryId: null,
            },
          ],
          timestampMs: source.timestampMs! - 1,
        },
      ],
    ])
    const result = buildWithPendingWs([source, reply], pendingWs)
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    // Only Path 1's single <delegate> linkage should exist.
    expect(linkages).toHaveLength(1)
    expect(linkages[0]!.source).toBe('delegate-tag')
    expect(linkages[0]!.targetAgentId).toBe('eng')
  })

  it('does NOT synthesize Path 4 for a workstreamId WITHOUT :implicit-fanout suffix', () => {
    // Regular workstreams (Round 10) use `:workstreams` suffix.
    // Path 4 ONLY handles `:implicit-fanout`. The Round 10 flow goes
    // through Path 1's workstreamId attribution path, not here.
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: 'normal turn, no fan-out prose',
    })
    const wsId = `t1:${source.entryId}:workstreams` // NOT :implicit-fanout
    const pendingWs = new Map<string, import('@/stores/chat').PendingWorkstreams>([
      [
        wsId,
        {
          workstreamId: wsId,
          sourceEntryId: source.entryId,
          sourceAgentId: 'bz',
          teamId: 't1',
          targets: [
            {
              targetAgentId: 'eng',
              targetAgentName: 'Engineer Boo',
              task: 'x',
              output: null,
              resolvedEntryId: null,
            },
          ],
          timestampMs: source.timestampMs!,
        },
      ],
    ])
    const result = buildWithPendingWs([source], pendingWs)
    const linkages = result.linkagesBySourceEntry.get(source.entryId) ?? []
    expect(linkages).toHaveLength(0)
  })
})

// ── Round 15 — leader-streaming pass ───────────────────────────────────────
// BEFORE the leader's source entry commits, its `<delegate>` blocks live
// only in `streamingText`. The Round 15 pass scans streaming texts for
// closed `<delegate>` tags and claims the targets so the target's reply
// (streaming OR briefly-pre-leader-commit) stops appearing at top level.

function buildWithStreaming(
  mergedEntries: TranscriptEntry[],
  streamingTexts: Map<string, string>,
  streamStartedAt?: Map<string, number>,
) {
  const blocks = groupEntriesToBlocks(mergedEntries)
  return buildDelegationLinkages({
    blocks,
    mergedEntries,
    teamId: 't1',
    participants,
    streamingTexts,
    streamStartedAt,
  })
}

describe('buildDelegationLinkages — Round 15 leader-streaming pass', () => {
  it('claims streaming-only target sessionKey when leader has not committed yet', () => {
    // The leader is still streaming; only their streaming text contains
    // the closed `<delegate>` tag. No committed leader entry exists. The
    // target hasn't committed yet either — pure pre-commit state.
    const streamingTexts = new Map<string, string>([
      [
        teamSk('bz'),
        'Working on it. <delegate to="@Engineer Boo">Do the thing</delegate> back soon.',
      ],
    ])
    const result = buildWithStreaming([], streamingTexts)
    // Streaming ownership transfers — the StreamingCard for the target
    // session will be suppressed.
    expect(result.streamingOwnerByTargetSessionKey.get(teamSk('eng'))).toBeDefined()
    expect(result.streamingOwnerByTargetSessionKey.get(teamSk('eng'))).toMatch(/^stream:/)
    // No committed entries → no linkages built — the actual Path 1
    // linkage will form when the leader commits.
    expect(result.linkagesByDelegationId.size).toBe(0)
  })

  it('claims a target reply that committed BEFORE the leader committed', () => {
    // Race: leader is streaming, target finishes first and commits. Without
    // Round 15 this committed target entry would appear at top level (no
    // linkage exists yet because the leader's source isn't in mergedEntries).
    const streamStarted = Date.now()
    const targetReply = makeAssistantEntry({
      sessionKey: teamSk('eng'),
      text: 'Here is the deliverable.',
      timestampMs: streamStarted + 2000,
    })
    const streamingTexts = new Map<string, string>([
      [teamSk('bz'), 'Coordinating now. <delegate to="@Engineer Boo">Build it</delegate>'],
    ])
    const streamStartedAt = new Map<string, number>([[teamSk('bz'), streamStarted]])
    const result = buildWithStreaming([targetReply], streamingTexts, streamStartedAt)
    expect(result.claimedEntries.has(targetReply.entryId)).toBe(true)
    expect(result.streamingOwnerByTargetSessionKey.has(teamSk('eng'))).toBe(true)
  })

  it('does NOT claim target entries from BEFORE the leader stream started', () => {
    // Stale entry: the target's previous onboarding intro was committed
    // BEFORE the leader started this turn's stream. Must NOT be claimed
    // by Round 15 — that's exactly the stale-content bug Round 14A
    // addressed for LiveActivityFeed and that the Round 15 pass must
    // honor here too.
    const streamStarted = Date.now()
    const staleEntry = makeAssistantEntry({
      sessionKey: teamSk('eng'),
      text: "Hi! I'm Engineer Boo, ready to help.",
      timestampMs: streamStarted - 60_000, // 1 minute before the stream
    })
    const streamingTexts = new Map<string, string>([
      [teamSk('bz'), '<delegate to="@Engineer Boo">Do it</delegate>'],
    ])
    const streamStartedAt = new Map<string, number>([[teamSk('bz'), streamStarted]])
    const result = buildWithStreaming([staleEntry], streamingTexts, streamStartedAt)
    expect(result.claimedEntries.has(staleEntry.entryId)).toBe(false)
    // But streaming ownership still transfers (no committed reply yet).
    expect(result.streamingOwnerByTargetSessionKey.has(teamSk('eng'))).toBe(true)
  })

  it('does NOT clobber a committed-path linkage that already owns the target', () => {
    // Both happened: the LEADER ALREADY committed (so Path 1 ran and
    // owns the linkage) AND the leader's NEXT turn is also streaming
    // with a `<delegate>` to the same target. Round 15 should NOT
    // overwrite the committed Path 1 owner with a `stream:` synthetic id.
    const source = makeAssistantEntry({
      sessionKey: teamSk('bz'),
      text: '<delegate to="@Engineer Boo">First task</delegate>',
    })
    const streamingTexts = new Map<string, string>([
      [teamSk('bz'), '<delegate to="@Engineer Boo">Second task, still streaming</delegate>'],
    ])
    const result = buildWithStreaming([source], streamingTexts)
    const owner = result.streamingOwnerByTargetSessionKey.get(teamSk('eng'))
    expect(owner).toBeDefined()
    // The committed linkage's delegationId is the source entry id with
    // a `:blockStart` suffix — NOT `stream:`. Round 15 must preserve it.
    expect(owner).not.toMatch(/^stream:/)
  })

  it('handles open / unclosed `<delegate>` tags by ignoring them (partial-stream safety)', () => {
    // The leader has typed `<delegate to="@Engineer Boo">` but the
    // closing tag hasn't arrived yet. `findDelegationBlocks` requires a
    // closing `</delegate>` — partial blocks are NOT yet routable, so
    // Round 15 should NOT claim ownership prematurely.
    const streamingTexts = new Map<string, string>([
      [teamSk('bz'), 'Routing now. <delegate to="@Engineer Boo">half a task, no closing tag'],
    ])
    const result = buildWithStreaming([], streamingTexts)
    expect(result.streamingOwnerByTargetSessionKey.size).toBe(0)
    expect(result.claimedEntries.size).toBe(0)
  })

  it('skips streaming texts for non-participant agents (defensive)', () => {
    // `streamingText` may contain sessions outside the current team
    // (older 1:1 chat sessions). They must NOT contribute claims.
    const streamingTexts = new Map<string, string>([
      ['agent:outsider:main', '<delegate to="@Engineer Boo">should be ignored</delegate>'],
    ])
    const result = buildWithStreaming([], streamingTexts)
    expect(result.streamingOwnerByTargetSessionKey.size).toBe(0)
  })

  it('skips empty / undefined streaming text values', () => {
    const streamingTexts = new Map<string, string>([[teamSk('bz'), '']])
    const result = buildWithStreaming([], streamingTexts)
    expect(result.streamingOwnerByTargetSessionKey.size).toBe(0)
  })

  it('claims multiple target sessions when the leader streams sibling delegates', () => {
    // Workstream batch — TWO closed `<delegate>` tags in the streaming
    // text. Both targets should be owned so their streams suppress.
    const streamingTexts = new Map<string, string>([
      [
        teamSk('bz'),
        '<delegate to="@Engineer Boo">Build it</delegate> and <delegate to="@Designer Boo">Style it</delegate>',
      ],
    ])
    const result = buildWithStreaming([], streamingTexts)
    expect(result.streamingOwnerByTargetSessionKey.has(teamSk('eng'))).toBe(true)
    expect(result.streamingOwnerByTargetSessionKey.has(teamSk('des'))).toBe(true)
  })
})
