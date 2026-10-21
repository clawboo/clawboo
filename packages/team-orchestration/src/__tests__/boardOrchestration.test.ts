// The pure-engine side of the cascade CONTRACT: run `runCascadeContract` against an
// in-memory `FakeBoard` that enforces the REAL transition rules (@clawboo/board-core,
// the same module @clawboo/db enforces inside its write transaction). The SAME
// contract runs against the REAL `serverBoardClient` in
// apps/web/server/lib/teamChat/__tests__/boardOrchestration.contract.test.ts.
//
// Board-independent unit tests (extractSignals — structured-only signal parsing)
// stay here directly; they don't touch a board.

import { describe, expect, it } from 'vitest'

import type { RuntimeEvent } from '@clawboo/executor'

import { extractSignals, type KnownAgent } from '../boardOrchestration'
import { runCascadeContract } from '../contract'
import { FakeBoard } from './fakeBoard'

// Run the full cascade-invariant contract against the in-memory fake.
runCascadeContract({ makeBoard: () => new FakeBoard() })

// ─── extractSignals (structured-only, board-independent) ──────────────────────

const KNOWN: KnownAgent[] = [
  { id: 'leader', name: 'Boo Zero' },
  { id: 'a2', name: 'Bug Boo' },
  { id: 'a3', name: 'Design Boo' },
  { id: 'a4', name: 'Test Boo' },
]

function doneEvent(runId: string, summary: string): RuntimeEvent {
  return { kind: 'done', reason: 'success', summary, runId, sessionId: null, ts: 1, seq: 1 }
}
function toolCallEvent(runId: string, name: string, input: unknown): RuntimeEvent {
  return {
    kind: 'tool-call',
    toolCallId: 'tc',
    name,
    input,
    partial: false,
    runId,
    sessionId: null,
    ts: 1,
    seq: 1,
  }
}

describe('extractSignals', () => {
  it('reads a sessions_send tool-call as a parallel delegation', () => {
    const ev = toolCallEvent('r1', 'sessions_send', { label: 'Bug Boo', message: 'fix the bug' })
    const out = extractSignals(ev, 'leader', KNOWN)
    expect(out.parallel).toEqual([
      { targetAgentId: 'a2', targetAgentName: 'Bug Boo', task: 'fix the bug' },
    ])
    expect(out.plan).toEqual([])
  })

  it('reads a `delegate` tool-call as a parallel delegation (native signal)', () => {
    const ev = toolCallEvent('r1', 'delegate', { assignee: 'Bug Boo', task: 'fix the bug' })
    const out = extractSignals(ev, 'leader', KNOWN)
    expect(out.parallel).toEqual([
      { targetAgentId: 'a2', targetAgentName: 'Bug Boo', task: 'fix the bug' },
    ])
    expect(out.plan).toEqual([])
  })

  it('resolves a namespaced `delegate` tool name (team_delegate)', () => {
    const ev = toolCallEvent('r1', 'team_delegate', { assignee: 'Bug Boo', task: 'x' })
    expect(extractSignals(ev, 'leader', KNOWN).parallel).toHaveLength(1)
  })

  it('drops a `delegate` tool-call to an unknown teammate', () => {
    const ev = toolCallEvent('r1', 'delegate', { assignee: 'Nobody', task: 'x' })
    const out = extractSignals(ev, 'leader', KNOWN)
    expect(out.parallel).toEqual([])
    expect(out.plan).toEqual([])
  })

  it('drops a self-delegation `delegate` tool-call', () => {
    const ev = toolCallEvent('r1', 'delegate', { assignee: 'Bug Boo', task: 'x' })
    // sourceAgentId === a2 (Bug Boo) targeting itself → skipped.
    expect(extractSignals(ev, 'a2', KNOWN).parallel).toEqual([])
  })

  it('drops a `delegate` tool-call with an empty task', () => {
    const ev = toolCallEvent('r1', 'delegate', { assignee: 'Bug Boo', task: '   ' })
    expect(extractSignals(ev, 'leader', KNOWN).parallel).toEqual([])
  })

  it('reads <delegate> tags from a done summary', () => {
    const ev = doneEvent('r1', 'Sure. <delegate to="@Bug Boo">fix it</delegate>')
    const out = extractSignals(ev, 'leader', KNOWN)
    expect(out.parallel).toHaveLength(1)
    expect(out.parallel[0]).toMatchObject({ targetAgentId: 'a2', task: 'fix it' })
  })

  it('reads <plan> steps as an ordered plan', () => {
    const ev = doneEvent(
      'r1',
      '<plan><step to="@Bug Boo">step one</step><step to="@Design Boo">step two</step></plan>',
    )
    const out = extractSignals(ev, 'leader', KNOWN)
    expect(out.plan.map((s) => s.targetAgentId)).toEqual(['a2', 'a3'])
    expect(out.parallel).toEqual([])
  })

  it('IGNORES natural-language @mentions (no structured tag = no delegation)', () => {
    const ev = doneEvent('r1', '@Bug Boo, please fix the bug when you get a chance.')
    const out = extractSignals(ev, 'leader', KNOWN)
    expect(out.parallel).toEqual([])
    expect(out.plan).toEqual([])
  })
})
