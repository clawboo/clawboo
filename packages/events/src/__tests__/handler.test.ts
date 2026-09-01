// createEventHandler — the pipeline's ONLY stateful stage, and specifically its
// `closedRuns` stale-run guard.
//
// The harness below deliberately EMULATES the real writer in
// `apps/web/src/features/connection/useGatewayEvents.ts` rather than counting
// calls on spies: `dispatchIntent` applies terminal patches to a mutable fleet
// runId, and skips the patch entirely while an exec approval is pending. That is
// the mechanism the guard threads its needle through — a run parked on an
// approval keeps its runId, so it is never marked closed and its legitimate
// post-approval continuation still commits. Tests therefore read as run
// lifecycles, which is what they are.
//
// Not covered: the 30 s `CLOSED_RUN_TTL_MS` expiry and the 500-entry eviction in
// `pruneClosedRuns`. Both read `Date.now()` directly and `EventHandlerDeps`
// injects only `setTimeout`/`clearTimeout`, so they are not drivable from here.

import { describe, it, expect } from 'vitest'
import { createEventHandler } from '../handler'
import type { ChatCost, ClassifiedEvent, EventHandlerDeps, EventIntent } from '../types'

// ── Harness ──────────────────────────────────────────────────────────────────

const AGENT = 'a1'
const SESSION = 'agent:a1:main'

const CHAT_EVENT: ClassifiedEvent = {
  kind: 'runtime-chat',
  agentId: AGENT,
  sessionKey: SESSION,
  payload: {},
  timestamp: 0,
  raw: { type: 'event', event: 'chat' },
}

function harness(initialRunId: string | null) {
  let fleetRunId = initialRunId
  let approvalPending = false
  const appended: string[][] = []
  const dispatched: EventIntent[] = []

  const deps: EventHandlerDeps = {
    getAgentRunId: () => fleetRunId,
    dispatchIntent: (intent) => {
      dispatched.push(intent)
      // Mirrors useGatewayEvents: a pending approval SKIPS the status patch, so
      // the run stays alive and the handler's pre/post comparison never fires.
      if (approvalPending) return
      if (intent.kind === 'commitChat' || intent.kind === 'updateAgentStatus') {
        // `!== undefined`, NOT `?? null` — `AgentStatusPatch.runId` is optional,
        // and `undefined ?? null` would wrongly clear a runId the patch never
        // mentioned.
        if (intent.patch.runId !== undefined) fleetRunId = intent.patch.runId
      }
    },
    queueLivePatch: () => {},
    clearPendingLivePatch: () => {},
    appendOutputLines: (_agentId, lines) => {
      appended.push(lines)
    },
    requestHistoryRefresh: async () => {},
    loadSummarySnapshot: async () => {},
    refreshHeartbeatLatest: () => {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  }

  return {
    handler: createEventHandler(deps),
    appended,
    dispatched,
    startRun: (id: string) => {
      fleetRunId = id
    },
    setApprovalPending: (pending: boolean) => {
      approvalPending = pending
    },
    currentRunId: () => fleetRunId,
  }
}

function commitChat(
  runId: string | null,
  lines: string[],
  cost: ChatCost | null = null,
): EventIntent {
  return {
    kind: 'commitChat',
    plane: 'work',
    agentId: AGENT,
    sessionKey: SESSION,
    runId,
    patch: {
      status: 'idle',
      runId: null,
      runStartedAt: null,
      streamText: null,
      thinkingTrace: null,
    },
    outputLines: lines,
    cost,
  }
}

const COST: ChatCost = { model: 'claude-opus-5', inputTokens: 100, outputTokens: 200 }

function terminalStatus(runId: string | null): EventIntent {
  return {
    kind: 'updateAgentStatus',
    plane: 'agent',
    agentId: AGENT,
    runId,
    patch: {
      status: 'idle',
      runId: null,
      runStartedAt: null,
      streamText: null,
      thinkingTrace: null,
    },
  }
}

const countOf = (intents: EventIntent[], kind: EventIntent['kind']): number =>
  intents.filter((i) => i.kind === kind).length

// ── commitChat ───────────────────────────────────────────────────────────────

describe('createEventHandler — commitChat closed-run guard', () => {
  it('commits a first chat final and closes the run', () => {
    const h = harness('r1')
    h.handler.applyIntents([commitChat('r1', ['hello'])], CHAT_EVENT)
    expect(h.appended).toEqual([['hello']])
    expect(countOf(h.dispatched, 'commitChat')).toBe(1)
    expect(h.currentRunId()).toBeNull()
  })

  it('drops a REPLAYED final for the same run (the triple-render root cause)', () => {
    const h = harness('r1')
    h.handler.applyIntents([commitChat('r1', ['hello'])], CHAT_EVENT)
    // The Gateway re-delivers the same terminal frame. Note the agent's runId is
    // already null by now — a `getAgentRunId()`-based guard could not see this.
    h.handler.applyIntents([commitChat('r1', ['hello'])], CHAT_EVENT)
    expect(h.appended).toEqual([['hello']])
    expect(countOf(h.dispatched, 'commitChat')).toBe(1)
  })

  it('still commits the final when the LIFECYCLE end arrived first', () => {
    // THE OPENCLAW WIRE ORDER, and the vanishing 1:1 reply. OpenClaw emits its
    // `agent` end frame BEFORE the `chat` final. Treating that close as "this run
    // is finished" dropped the final that followed, so the reply rendered as a
    // live streaming card and then disappeared: nothing appended, nothing
    // persisted, and every recovery belt downstream sat inside a dispatch that
    // was never reached. A lifecycle close means the run STOPPED, not that it
    // delivered.
    const h = harness('r1')
    h.handler.applyIntents([terminalStatus('r1')], CHAT_EVENT)
    h.handler.applyIntents([commitChat('r1', ['the reply'])], CHAT_EVENT)
    expect(h.appended).toEqual([['the reply']])
    expect(countOf(h.dispatched, 'commitChat')).toBe(1)
  })

  it('still drops a replayed final after the run committed once', () => {
    // The narrowing must not cost the guard its original job: a run that already
    // COMMITTED has said everything, so a second final is a replay.
    const h = harness('r1')
    h.handler.applyIntents([commitChat('r1', ['hello'])], CHAT_EVENT)
    h.handler.applyIntents([terminalStatus('r1')], CHAT_EVENT)
    h.handler.applyIntents([commitChat('r1', ['hello'])], CHAT_EVENT)
    expect(h.appended).toEqual([['hello']])
    expect(countOf(h.dispatched, 'commitChat')).toBe(1)
  })

  it('drops a REPLAYED final under the real wire order too', () => {
    // THE HOLE THE FIRST ATTEMPT LEFT. Marking the run closed used a pre/post
    // runId comparison, but under the real order the lifecycle end has already
    // nulled the runId before the final arrives, so the comparison read
    // null-to-null and never marked anything. A replayed final then appended the
    // reply a second time: the triple-render bug, back by another door.
    const h = harness('r1')
    h.handler.applyIntents([terminalStatus('r1')], CHAT_EVENT)
    h.handler.applyIntents([commitChat('r1', ['the reply'])], CHAT_EVENT)
    h.handler.applyIntents([commitChat('r1', ['the reply'])], CHAT_EVENT)
    expect(h.appended).toEqual([['the reply']])
    expect(countOf(h.dispatched, 'commitChat')).toBe(1)
  })

  it('never lets a stale final flip a NEWLY started run to idle', () => {
    // The guard's other job. A replay arriving inside the 30s window, after the
    // agent has started its next run, carries a terminal patch; letting it
    // through would clear the live run's id and strand it.
    const h = harness('r1')
    h.handler.applyIntents([terminalStatus('r1')], CHAT_EVENT)
    h.startRun('r2')
    h.handler.applyIntents([commitChat('r1', ['stale'])], CHAT_EVENT)
    expect(h.currentRunId()).toBe('r2')
  })

  it('lets a DIFFERENT run commit after the first closed', () => {
    const h = harness('r1')
    h.handler.applyIntents([commitChat('r1', ['first'])], CHAT_EVENT)
    h.startRun('r2')
    h.handler.applyIntents([commitChat('r2', ['second'])], CHAT_EVENT)
    expect(h.appended).toEqual([['first'], ['second']])
  })

  it('lets a post-approval continuation through (same runId, different text)', () => {
    const h = harness('r1')
    // The LLM stream ends while an exec approval is pending: output lines are
    // appended but the status patch is skipped, so the run stays alive.
    h.setApprovalPending(true)
    h.handler.applyIntents([commitChat('r1', ['first'])], CHAT_EVENT)
    expect(h.currentRunId()).toBe('r1')

    // The approval resolves and the run produces its REAL final.
    h.setApprovalPending(false)
    h.handler.applyIntents([commitChat('r1', ['second'])], CHAT_EVENT)

    expect(h.appended).toEqual([['first'], ['second']])
    expect(h.currentRunId()).toBeNull()
  })

  it('a replayed final cannot clobber a freshly-started run', () => {
    const h = harness('r1')
    h.handler.applyIntents([commitChat('r1', ['first'])], CHAT_EVENT)
    h.startRun('r2')
    // Late replay of r1's final. Without the guard, its terminal patch would
    // flip the live r2 run to idle and null its runId.
    h.handler.applyIntents([commitChat('r1', ['first'])], CHAT_EVENT)
    expect(h.currentRunId()).toBe('r2')
    expect(h.appended).toEqual([['first']])
  })

  it('fails OPEN when the frame carries no runId', () => {
    const h = harness('r1')
    h.handler.applyIntents([commitChat('r1', ['first'])], CHAT_EVENT)
    // Unknown provenance: losing a real message is worse than a duplicate.
    h.handler.applyIntents([commitChat(null, ['unattributed'])], CHAT_EVENT)
    expect(h.appended).toEqual([['first'], ['unattributed']])
  })

  it('skips appendOutputLines for an empty commit (aborted / error finals)', () => {
    const h = harness('r1')
    h.handler.applyIntents([commitChat('r1', [])], CHAT_EVENT)
    expect(h.appended).toEqual([])
    expect(countOf(h.dispatched, 'commitChat')).toBe(1)
  })
})

// ── Cost accounting ──────────────────────────────────────────────────────────
//
// Token spend rides on `commitChat` so it inherits the guard above. Before this,
// billing ran off a SECOND raw-frame subscription in `useGatewayEvents` that
// re-parsed every `chat:final` itself — outside the pipeline, so a replayed
// frame was charged twice.

describe('createEventHandler — cost accounting rides the guard', () => {
  const billed = (dispatched: EventIntent[]): ChatCost[] =>
    dispatched.flatMap((i) => (i.kind === 'commitChat' && i.cost ? [i.cost] : []))

  it('bills a committed turn exactly once', () => {
    const h = harness('r1')
    h.handler.applyIntents([commitChat('r1', ['hello'], COST)], CHAT_EVENT)
    expect(billed(h.dispatched)).toEqual([COST])
  })

  it('does NOT bill a replayed final twice', () => {
    const h = harness('r1')
    h.handler.applyIntents([commitChat('r1', ['hello'], COST)], CHAT_EVENT)
    h.handler.applyIntents([commitChat('r1', ['hello'], COST)], CHAT_EVENT)
    expect(billed(h.dispatched)).toEqual([COST])
  })

  it('bills BOTH halves of a post-approval continuation', () => {
    // Two finals, one runId, different spend — the run is never closed while the
    // approval is pending, so both are real turns and both must be charged.
    const first: ChatCost = { model: 'm', inputTokens: 10, outputTokens: 20 }
    const second: ChatCost = { model: 'm', inputTokens: 30, outputTokens: 40 }
    const h = harness('r1')
    h.setApprovalPending(true)
    h.handler.applyIntents([commitChat('r1', ['first'], first)], CHAT_EVENT)
    h.setApprovalPending(false)
    h.handler.applyIntents([commitChat('r1', ['second'], second)], CHAT_EVENT)
    expect(billed(h.dispatched)).toEqual([first, second])
  })
})

// ── updateAgentStatus ────────────────────────────────────────────────────────

describe('createEventHandler — updateAgentStatus closed-run guard', () => {
  it('drops a late terminal status for a run that already closed', () => {
    const h = harness('r1')
    h.handler.applyIntents([commitChat('r1', ['done'])], CHAT_EVENT)
    h.startRun('r2')
    // A late lifecycle `end` for r1. Before the incoming-runId fix this flipped
    // the live r2 run back to idle.
    h.handler.applyIntents([terminalStatus('r1')], CHAT_EVENT)
    expect(h.currentRunId()).toBe('r2')
    expect(countOf(h.dispatched, 'updateAgentStatus')).toBe(0)
  })

  it('lets a terminal status for a still-open run through', () => {
    const h = harness('r1')
    h.handler.applyIntents([terminalStatus('r1')], CHAT_EVENT)
    expect(countOf(h.dispatched, 'updateAgentStatus')).toBe(1)
    expect(h.currentRunId()).toBeNull()
  })

  it('never drops a `running` status, even for a closed runId', () => {
    const h = harness('r1')
    h.handler.applyIntents([commitChat('r1', ['done'])], CHAT_EVENT)
    h.handler.applyIntents(
      [
        {
          kind: 'updateAgentStatus',
          plane: 'agent',
          agentId: AGENT,
          runId: 'r1',
          patch: { status: 'running', runId: 'r1', runStartedAt: 1 },
        },
      ],
      CHAT_EVENT,
    )
    expect(countOf(h.dispatched, 'updateAgentStatus')).toBe(1)
    expect(h.currentRunId()).toBe('r1')
  })
})

// ── dispose ──────────────────────────────────────────────────────────────────

describe('createEventHandler — dispose', () => {
  it('clears closedRuns so a reconnect starts clean', () => {
    const h = harness('r1')
    h.handler.applyIntents([commitChat('r1', ['first'])], CHAT_EVENT)
    h.handler.dispose()
    // After a Gateway reconnect the same runId must not be treated as closed.
    h.startRun('r1')
    h.handler.applyIntents([commitChat('r1', ['first'])], CHAT_EVENT)
    expect(h.appended).toEqual([['first'], ['first']])
  })
})
