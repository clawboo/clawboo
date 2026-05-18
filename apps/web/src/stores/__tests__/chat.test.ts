import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../chat'
import type { TranscriptEntry } from '@clawboo/protocol'

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Factory uses the entryId as part of the text + slightly-staggered timestamps
 * so distinct entries are content-distinct too. The store now dedupes by
 * content signature in addition to entryId (Round 2, Phase A) — tests that
 * relied on multiple `entryId`s with identical text + timestamp were
 * exercising a degenerate case that doesn't occur in production.
 */
let nextTs = 1_700_000_000_000
function makeEntry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  const id = overrides.entryId ?? `e${nextTs}`
  return {
    entryId: id,
    kind: 'assistant',
    source: 'runtime',
    text: `Hello world ${id}`,
    timestamp: nextTs++,
    timestampMs: nextTs,
    ...overrides,
  } as TranscriptEntry
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useChatStore', () => {
  beforeEach(() => {
    useChatStore.setState({
      transcripts: new Map(),
      streamingText: new Map(),
      streamStartedAt: new Map(),
      lastTokenUsage: new Map(),
    })
  })

  it('starts with empty maps', () => {
    const state = useChatStore.getState()
    expect(state.transcripts.size).toBe(0)
    expect(state.streamingText.size).toBe(0)
    expect(state.streamStartedAt.size).toBe(0)
    expect(state.lastTokenUsage.size).toBe(0)
  })

  describe('appendTranscript', () => {
    it('adds entries for a session', () => {
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      const entries = useChatStore.getState().transcripts.get('s1')
      expect(entries).toHaveLength(1)
      expect(entries![0].entryId).toBe('e1')
    })

    it('deduplicates by entryId', () => {
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      expect(useChatStore.getState().transcripts.get('s1')).toHaveLength(1)
    })

    it('appends fresh entries alongside existing', () => {
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e2' })])
      expect(useChatStore.getState().transcripts.get('s1')).toHaveLength(2)
    })

    it('caps at 500 entries', () => {
      const batch = Array.from({ length: 510 }, (_, i) => makeEntry({ entryId: `e${i}` }))
      useChatStore.getState().appendTranscript('s1', batch)
      const entries = useChatStore.getState().transcripts.get('s1')
      expect(entries).toHaveLength(500)
      // Should keep the last 500 (e10–e509)
      expect(entries![0].entryId).toBe('e10')
      expect(entries![499].entryId).toBe('e509')
    })

    it('returns same state ref if all entries are duplicates', () => {
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      const before = useChatStore.getState()
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      const after = useChatStore.getState()
      // Zustand should return the same state object reference when nothing changes
      expect(before.transcripts).toBe(after.transcripts)
    })

    it('does not affect other sessions', () => {
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      useChatStore.getState().appendTranscript('s2', [makeEntry({ entryId: 'e2' })])
      expect(useChatStore.getState().transcripts.get('s1')).toHaveLength(1)
      expect(useChatStore.getState().transcripts.get('s2')).toHaveLength(1)
    })
  })

  describe('setStreamingText', () => {
    it('stores text for a session', () => {
      useChatStore.getState().setStreamingText('s1', 'thinking...')
      expect(useChatStore.getState().streamingText.get('s1')).toBe('thinking...')
    })

    it('clears with null', () => {
      useChatStore.getState().setStreamingText('s1', 'thinking...')
      useChatStore.getState().setStreamingText('s1', null)
      expect(useChatStore.getState().streamingText.has('s1')).toBe(false)
    })

    it('overwrites previous text', () => {
      useChatStore.getState().setStreamingText('s1', 'first')
      useChatStore.getState().setStreamingText('s1', 'second')
      expect(useChatStore.getState().streamingText.get('s1')).toBe('second')
    })
  })

  describe('clearTranscript', () => {
    it('removes transcript and streaming for a session', () => {
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      useChatStore.getState().setStreamingText('s1', 'hello')
      useChatStore.getState().clearTranscript('s1')
      expect(useChatStore.getState().transcripts.has('s1')).toBe(false)
      expect(useChatStore.getState().streamingText.has('s1')).toBe(false)
    })

    it('does not affect other sessions', () => {
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      useChatStore.getState().appendTranscript('s2', [makeEntry({ entryId: 'e2' })])
      useChatStore.getState().setStreamingText('s2', 'hello')
      useChatStore.getState().clearTranscript('s1')
      expect(useChatStore.getState().transcripts.get('s2')).toHaveLength(1)
      expect(useChatStore.getState().streamingText.get('s2')).toBe('hello')
    })

    it('does not affect lastTokenUsage', () => {
      useChatStore.getState().setLastTokenUsage('r1', 100, 200)
      useChatStore.getState().clearTranscript('s1')
      expect(useChatStore.getState().lastTokenUsage.get('r1')).toEqual({
        inputTokens: 100,
        outputTokens: 200,
      })
    })
  })

  describe('setLastTokenUsage', () => {
    it('stores usage for a runId', () => {
      useChatStore.getState().setLastTokenUsage('r1', 100, 200)
      expect(useChatStore.getState().lastTokenUsage.get('r1')).toEqual({
        inputTokens: 100,
        outputTokens: 200,
      })
    })

    it('overwrites previous usage', () => {
      useChatStore.getState().setLastTokenUsage('r1', 100, 200)
      useChatStore.getState().setLastTokenUsage('r1', 300, 400)
      expect(useChatStore.getState().lastTokenUsage.get('r1')).toEqual({
        inputTokens: 300,
        outputTokens: 400,
      })
    })

    it('stores multiple runIds independently', () => {
      useChatStore.getState().setLastTokenUsage('r1', 100, 200)
      useChatStore.getState().setLastTokenUsage('r2', 300, 400)
      expect(useChatStore.getState().lastTokenUsage.size).toBe(2)
      expect(useChatStore.getState().lastTokenUsage.get('r1')!.inputTokens).toBe(100)
      expect(useChatStore.getState().lastTokenUsage.get('r2')!.inputTokens).toBe(300)
    })
  })

  // Round 5: stream-start timestamps moved from `lib/streamStartTracker.ts`
  // into the chat store so renderers can subscribe reactively. The store
  // anchors live `StreamingCard`s at their chronological position; on commit
  // the entry's `timestampMs` reuses the same value so there's zero visible
  // re-arrangement when the stream lands.
  describe('setStreamStart / clearStreamStart', () => {
    it('captures the first stream-start timestamp for a session', () => {
      useChatStore.getState().setStreamStart('agent:a1:main', 1000)
      expect(useChatStore.getState().streamStartedAt.get('agent:a1:main')).toBe(1000)
    })

    it('first capture wins — subsequent setStreamStart calls do not reset', () => {
      useChatStore.getState().setStreamStart('agent:a1:main', 1000)
      useChatStore.getState().setStreamStart('agent:a1:main', 1500)
      useChatStore.getState().setStreamStart('agent:a1:main', 2000)
      expect(useChatStore.getState().streamStartedAt.get('agent:a1:main')).toBe(1000)
    })

    it('clearStreamStart removes the anchor', () => {
      useChatStore.getState().setStreamStart('agent:a1:main', 1000)
      useChatStore.getState().clearStreamStart('agent:a1:main')
      expect(useChatStore.getState().streamStartedAt.has('agent:a1:main')).toBe(false)
    })

    it('the next stream after clear re-anchors from scratch', () => {
      useChatStore.getState().setStreamStart('agent:a1:main', 1000)
      useChatStore.getState().clearStreamStart('agent:a1:main')
      useChatStore.getState().setStreamStart('agent:a1:main', 5000)
      expect(useChatStore.getState().streamStartedAt.get('agent:a1:main')).toBe(5000)
    })

    it('clearStreamStart is a no-op when the session has no anchor', () => {
      const before = useChatStore.getState().streamStartedAt
      useChatStore.getState().clearStreamStart('agent:nonexistent:main')
      // Reference stays identical when nothing changed (Round 5 contract).
      expect(useChatStore.getState().streamStartedAt).toBe(before)
    })

    it('isolates sessions — capturing one does not leak into another', () => {
      useChatStore.getState().setStreamStart('agent:leader:team:t1', 1000)
      useChatStore.getState().setStreamStart('agent:specialist:team:t1', 1500)
      expect(useChatStore.getState().streamStartedAt.get('agent:leader:team:t1')).toBe(1000)
      expect(useChatStore.getState().streamStartedAt.get('agent:specialist:team:t1')).toBe(1500)
    })

    it("clearTranscript also wipes the session's stream-start anchor", () => {
      useChatStore.getState().setStreamStart('agent:a1:main', 1000)
      useChatStore.getState().clearTranscript('agent:a1:main')
      expect(useChatStore.getState().streamStartedAt.has('agent:a1:main')).toBe(false)
    })

    it('emits a new state reference (renderers re-subscribe correctly)', () => {
      const before = useChatStore.getState().streamStartedAt
      useChatStore.getState().setStreamStart('agent:a1:main', 1000)
      const after = useChatStore.getState().streamStartedAt
      expect(after).not.toBe(before)
    })
  })

  // Round 7: setClawbooDispatch + clearClawbooDispatches. The store records
  // every `chat.send` Clawboo fires to a team specialist so the renderer
  // can surface those events as DelegationCards (Path 3 in
  // `buildDelegationLinkages`), independent of LLM emission format.
  describe('setClawbooDispatch / clearClawbooDispatches', () => {
    beforeEach(() => {
      useChatStore.setState({
        clawbooDispatches: new Map(),
      })
    })

    function makeDispatch(overrides: Partial<import('../chat').ClawbooDispatch> = {}) {
      return {
        dispatchId: 'd-' + Math.random().toString(36).slice(2, 9),
        sourceEntryId: 'src-1',
        sourceAgentId: 'bz',
        targetAgentId: 'eng',
        targetAgentName: 'Engineer Boo',
        taskBody: 'do the thing',
        origin: 'dispatch-delegation' as const,
        sequenceKey: 1,
        timestampMs: 1_700_000_000_000,
        teamId: 't1',
        ...overrides,
      }
    }

    it('stores a dispatch under the `${teamId}:${sourceEntryId}` key', () => {
      const dispatch = makeDispatch()
      useChatStore.getState().setClawbooDispatch(dispatch)
      const stored = useChatStore.getState().clawbooDispatches.get('t1:src-1')
      expect(stored).toHaveLength(1)
      expect(stored![0]).toBe(dispatch)
    })

    it('accumulates multiple dispatches under the same source entry', () => {
      useChatStore
        .getState()
        .setClawbooDispatch(makeDispatch({ dispatchId: 'd-a', targetAgentId: 'eng' }))
      useChatStore
        .getState()
        .setClawbooDispatch(makeDispatch({ dispatchId: 'd-b', targetAgentId: 'des' }))
      useChatStore
        .getState()
        .setClawbooDispatch(makeDispatch({ dispatchId: 'd-c', targetAgentId: 'his' }))
      const stored = useChatStore.getState().clawbooDispatches.get('t1:src-1')
      expect(stored).toHaveLength(3)
      expect(stored!.map((d) => d.dispatchId)).toEqual(['d-a', 'd-b', 'd-c'])
    })

    it('dedups by dispatchId — a retry with the same id is a no-op', () => {
      const dispatch = makeDispatch()
      useChatStore.getState().setClawbooDispatch(dispatch)
      useChatStore.getState().setClawbooDispatch(dispatch)
      useChatStore.getState().setClawbooDispatch(dispatch)
      expect(useChatStore.getState().clawbooDispatches.get('t1:src-1')).toHaveLength(1)
    })

    it('clearClawbooDispatches(teamId) wipes only that team — other teams untouched', () => {
      useChatStore.getState().setClawbooDispatch(makeDispatch({ teamId: 't1', sourceEntryId: 'a' }))
      useChatStore.getState().setClawbooDispatch(makeDispatch({ teamId: 't1', sourceEntryId: 'b' }))
      useChatStore.getState().setClawbooDispatch(makeDispatch({ teamId: 't2', sourceEntryId: 'a' }))
      useChatStore.getState().clearClawbooDispatches('t1')
      expect(useChatStore.getState().clawbooDispatches.has('t1:a')).toBe(false)
      expect(useChatStore.getState().clawbooDispatches.has('t1:b')).toBe(false)
      // t2 still there.
      expect(useChatStore.getState().clawbooDispatches.has('t2:a')).toBe(true)
    })
  })

  // Round 8B: pending-plan state machine actions.
  describe('setPendingPlan / resolvePlanStep / clearPendingPlans', () => {
    beforeEach(() => {
      useChatStore.setState({
        pendingPlans: new Map(),
      })
    })

    function makePlan(overrides: Partial<import('../chat').PendingPlan> = {}) {
      return {
        planId: 't1:src-1:plan:0',
        sourceEntryId: 'src-1',
        sourceAgentId: 'bz',
        teamId: 't1',
        steps: [
          {
            targetName: 'A',
            targetAgentId: 'a',
            task: 'step 1',
            output: null,
            resolvedEntryId: null,
          },
          {
            targetName: 'B',
            targetAgentId: 'b',
            task: 'step 2',
            output: null,
            resolvedEntryId: null,
          },
          {
            targetName: 'C',
            targetAgentId: 'c',
            task: 'step 3',
            output: null,
            resolvedEntryId: null,
          },
        ],
        currentStepIndex: 0,
        timestampMs: 1_700_000_000_000,
        ...overrides,
      }
    }

    it('stores a new plan by planId', () => {
      const plan = makePlan()
      useChatStore.getState().setPendingPlan(plan)
      expect(useChatStore.getState().pendingPlans.get(plan.planId)).toBe(plan)
    })

    it('setPendingPlan is idempotent — re-registering same planId is a no-op (preserves progress)', () => {
      const plan = makePlan()
      useChatStore.getState().setPendingPlan(plan)
      // Manually advance progress
      useChatStore.getState().resolvePlanStep(plan.planId, 0, 'output from A', 'reply-a')
      // Attempt re-register with the SAME planId — should NOT clobber progress
      useChatStore.getState().setPendingPlan(plan)
      const after = useChatStore.getState().pendingPlans.get(plan.planId)!
      expect(after.currentStepIndex).toBe(1)
      expect(after.steps[0]!.output).toBe('output from A')
    })

    it('resolvePlanStep stores output + advances currentStepIndex when resolving the head step', () => {
      const plan = makePlan()
      useChatStore.getState().setPendingPlan(plan)
      useChatStore.getState().resolvePlanStep(plan.planId, 0, 'A produced this', 'reply-a')
      const after = useChatStore.getState().pendingPlans.get(plan.planId)!
      expect(after.steps[0]!.output).toBe('A produced this')
      expect(after.steps[0]!.resolvedEntryId).toBe('reply-a')
      expect(after.currentStepIndex).toBe(1)
    })

    it('resolvePlanStep is idempotent — same resolution data does not double-advance', () => {
      const plan = makePlan()
      useChatStore.getState().setPendingPlan(plan)
      useChatStore.getState().resolvePlanStep(plan.planId, 0, 'A produced this', 'reply-a')
      useChatStore.getState().resolvePlanStep(plan.planId, 0, 'A produced this', 'reply-a')
      const after = useChatStore.getState().pendingPlans.get(plan.planId)!
      expect(after.currentStepIndex).toBe(1) // not 2
    })

    it('resolvePlanStep does NOT advance currentStepIndex for out-of-order resolutions', () => {
      const plan = makePlan()
      useChatStore.getState().setPendingPlan(plan)
      // Resolve step 2 before step 0 — rare but possible if a later target
      // replies first. We store the output but don't advance the head.
      useChatStore.getState().resolvePlanStep(plan.planId, 2, 'C result', 'reply-c')
      const after = useChatStore.getState().pendingPlans.get(plan.planId)!
      expect(after.currentStepIndex).toBe(0)
      expect(after.steps[2]!.output).toBe('C result')
    })

    it('resolvePlanStep is a no-op for unknown plan or step index', () => {
      const before = useChatStore.getState().pendingPlans
      useChatStore.getState().resolvePlanStep('nonexistent', 0, 'x', 'y')
      const after = useChatStore.getState().pendingPlans
      expect(after).toBe(before) // same ref
    })

    it('clearPendingPlans(teamId) wipes only that team — other teams untouched', () => {
      useChatStore.getState().setPendingPlan(makePlan({ planId: 't1:p1', teamId: 't1' }))
      useChatStore.getState().setPendingPlan(makePlan({ planId: 't1:p2', teamId: 't1' }))
      useChatStore.getState().setPendingPlan(makePlan({ planId: 't2:p1', teamId: 't2' }))
      useChatStore.getState().clearPendingPlans('t1')
      expect(useChatStore.getState().pendingPlans.has('t1:p1')).toBe(false)
      expect(useChatStore.getState().pendingPlans.has('t1:p2')).toBe(false)
      expect(useChatStore.getState().pendingPlans.has('t2:p1')).toBe(true)
    })

    it('initial state has empty pendingPlans', () => {
      // beforeEach reset → empty.
      expect(useChatStore.getState().pendingPlans.size).toBe(0)
    })
  })

  // Round 10: parallel-workstreams state machine actions.
  describe('setPendingWorkstreams / resolveWorkstreamTarget / clearPendingWorkstreams', () => {
    beforeEach(() => {
      useChatStore.setState({
        pendingWorkstreams: new Map(),
      })
    })

    function makeWorkstreams(
      overrides: Partial<import('../chat').PendingWorkstreams> = {},
    ): import('../chat').PendingWorkstreams {
      return {
        workstreamId: 't1:src-1:workstreams',
        sourceEntryId: 'src-1',
        sourceAgentId: 'bz',
        teamId: 't1',
        targets: [
          {
            targetAgentId: 'a',
            targetAgentName: 'A',
            task: 'workstream 1 task',
            output: null,
            resolvedEntryId: null,
          },
          {
            targetAgentId: 'b',
            targetAgentName: 'B',
            task: 'workstream 2 task',
            output: null,
            resolvedEntryId: null,
          },
          {
            targetAgentId: 'c',
            targetAgentName: 'C',
            task: 'workstream 3 task',
            output: null,
            resolvedEntryId: null,
          },
        ],
        timestampMs: 1_700_000_000_000,
        ...overrides,
      }
    }

    it('stores a new workstreams record by workstreamId', () => {
      const ws = makeWorkstreams()
      useChatStore.getState().setPendingWorkstreams(ws)
      expect(useChatStore.getState().pendingWorkstreams.get(ws.workstreamId)).toBe(ws)
    })

    it('setPendingWorkstreams is idempotent — re-registering preserves resolved targets', () => {
      const ws = makeWorkstreams()
      useChatStore.getState().setPendingWorkstreams(ws)
      // Resolve target 'b' to capture in-flight progress.
      useChatStore.getState().resolveWorkstreamTarget(ws.workstreamId, 'b', 'B output', 'reply-b')
      // Re-registering the SAME workstreamId must NOT clobber progress.
      useChatStore.getState().setPendingWorkstreams(ws)
      const after = useChatStore.getState().pendingWorkstreams.get(ws.workstreamId)!
      expect(after.targets[1]!.resolvedEntryId).toBe('reply-b')
      expect(after.targets[1]!.output).toBe('B output')
    })

    it('resolveWorkstreamTarget stores output for any target (parallel, no ordering)', () => {
      const ws = makeWorkstreams()
      useChatStore.getState().setPendingWorkstreams(ws)
      // Resolve out-of-order: target C first, then A — parallel semantics
      // don't care which lands first.
      useChatStore.getState().resolveWorkstreamTarget(ws.workstreamId, 'c', 'C result', 'reply-c')
      useChatStore.getState().resolveWorkstreamTarget(ws.workstreamId, 'a', 'A result', 'reply-a')
      const after = useChatStore.getState().pendingWorkstreams.get(ws.workstreamId)!
      expect(after.targets[0]!.output).toBe('A result')
      expect(after.targets[0]!.resolvedEntryId).toBe('reply-a')
      expect(after.targets[2]!.output).toBe('C result')
      expect(after.targets[2]!.resolvedEntryId).toBe('reply-c')
      // Target B is still unresolved.
      expect(after.targets[1]!.resolvedEntryId).toBeNull()
    })

    it('resolveWorkstreamTarget is idempotent — same payload is a no-op', () => {
      const ws = makeWorkstreams()
      useChatStore.getState().setPendingWorkstreams(ws)
      useChatStore.getState().resolveWorkstreamTarget(ws.workstreamId, 'a', 'A result', 'reply-a')
      const after1 = useChatStore.getState().pendingWorkstreams
      // Re-fire with the same payload — store should return the previous state ref.
      useChatStore.getState().resolveWorkstreamTarget(ws.workstreamId, 'a', 'A result', 'reply-a')
      const after2 = useChatStore.getState().pendingWorkstreams
      expect(after2).toBe(after1)
    })

    it('resolveWorkstreamTarget is a no-op for unknown workstream or target', () => {
      const ws = makeWorkstreams()
      useChatStore.getState().setPendingWorkstreams(ws)
      const before = useChatStore.getState().pendingWorkstreams
      // Unknown workstream id.
      useChatStore.getState().resolveWorkstreamTarget('nonexistent', 'a', 'x', 'y')
      // Unknown target agent id on a known workstream.
      useChatStore.getState().resolveWorkstreamTarget(ws.workstreamId, 'never-in-team', 'x', 'y')
      const after = useChatStore.getState().pendingWorkstreams
      expect(after).toBe(before)
    })

    it('clearPendingWorkstreams(teamId) wipes only that team — other teams untouched', () => {
      useChatStore
        .getState()
        .setPendingWorkstreams(makeWorkstreams({ workstreamId: 't1:w1', teamId: 't1' }))
      useChatStore
        .getState()
        .setPendingWorkstreams(makeWorkstreams({ workstreamId: 't1:w2', teamId: 't1' }))
      useChatStore
        .getState()
        .setPendingWorkstreams(makeWorkstreams({ workstreamId: 't2:w1', teamId: 't2' }))
      useChatStore.getState().clearPendingWorkstreams('t1')
      expect(useChatStore.getState().pendingWorkstreams.has('t1:w1')).toBe(false)
      expect(useChatStore.getState().pendingWorkstreams.has('t1:w2')).toBe(false)
      expect(useChatStore.getState().pendingWorkstreams.has('t2:w1')).toBe(true)
    })

    it('initial state has empty pendingWorkstreams', () => {
      expect(useChatStore.getState().pendingWorkstreams.size).toBe(0)
    })
  })
})
