// The pure-engine side of the cascade CONTRACT: run `runCascadeContract` against an
// in-memory `FakeBoard` (a deterministic mirror of the @clawboo/db board state
// machine). The SAME contract runs against the REAL `serverBoardClient` in
// apps/web/server/lib/teamChat/__tests__/boardOrchestration.contract.test.ts —
// any divergence between the two board state machines fails one of the two runs.
//
// Board-independent unit tests (extractSignals — structured-only signal parsing)
// stay here directly; they don't touch a board.

import { describe, expect, it } from 'vitest'

import type { RuntimeEvent } from '@clawboo/executor'

import { extractSignals, type KnownAgent } from '../boardOrchestration'
import type {
  BoardTask,
  ClaimResult,
  CompleteExecutionOutcome,
  CreateTaskInput,
  ExecutionRef,
  TaskDetail,
} from '../boardClient'
import { runCascadeContract, type CascadeBoard } from '../contract'

// ─── FakeBoard — the in-memory reference implementation ───────────────────────

interface FakeRow {
  id: string
  status: string
  parentTaskId: string | null
  title: string
  description: string
  sourceDelegationId: string | null
  assigneeAgentId: string | null
}

// Mirror of the server state machine (packages/db/src/board/state-machine.ts) so
// the fake rejects an illegal transition exactly as the real repo's updateStatus
// does (e.g. a `todo → done` after the task was released out from under a client).
const LEGAL_TX: Record<string, readonly string[]> = {
  backlog: ['todo', 'blocked', 'cancelled'],
  todo: ['in_progress', 'blocked', 'backlog', 'cancelled'],
  in_progress: ['in_review', 'done', 'blocked', 'todo', 'cancelled'],
  in_review: ['done', 'in_progress', 'blocked', 'cancelled'],
  blocked: ['todo', 'in_progress', 'backlog', 'cancelled'],
  done: [],
  cancelled: [],
}
const canTx = (from: string, to: string): boolean =>
  from === to || (LEGAL_TX[from] ?? []).includes(to)

class FakeBoard implements CascadeBoard {
  tasks = new Map<string, FakeRow>()
  depMap = new Map<string, string[]>() // taskId → [dependsOnTaskId]
  comments: { taskId: string; body: string }[] = []
  statusUpdates: { taskId: string; status: string }[] = []
  claims: string[] = []
  execs = new Map<string, string>()
  completed: { execId: string; outcome: CompleteExecutionOutcome }[] = []
  created: BoardTask[] = []
  forceClaimConflict = false
  onCreate?: () => void
  onClaim?: () => void
  private taskN = 0
  private execN = 0

  get execCount(): number {
    return this.execs.size
  }

  private toBoardTask(t: FakeRow): BoardTask {
    return {
      id: t.id,
      status: t.status,
      title: t.title,
      description: t.description,
      parentTaskId: t.parentTaskId,
      sourceDelegationId: t.sourceDelegationId,
      assigneeAgentId: t.assigneeAgentId,
    }
  }

  async createTask(input: CreateTaskInput): Promise<BoardTask | null> {
    this.onCreate?.()
    const id = `task-${++this.taskN}`
    const row: FakeRow = {
      id,
      status: 'todo',
      parentTaskId: input.parentTaskId ?? null,
      title: input.title,
      description: input.description ?? '',
      sourceDelegationId: input.sourceDelegationId ?? null,
      assigneeAgentId: null,
    }
    this.tasks.set(id, row)
    const bt = this.toBoardTask(row)
    this.created.push(bt)
    return bt
  }
  async claim(taskId: string, assigneeAgentId?: string): Promise<ClaimResult> {
    this.onClaim?.()
    this.claims.push(taskId)
    if (this.forceClaimConflict) return { ok: false, reason: 'conflict' }
    const t = this.tasks.get(taskId)
    if (!t || t.status !== 'todo' || t.assigneeAgentId) return { ok: false, reason: 'conflict' }
    t.status = 'in_progress'
    t.assigneeAgentId = assigneeAgentId ?? 'someone'
    return { ok: true, task: this.toBoardTask(t) }
  }
  async updateStatus(taskId: string, status: string): Promise<boolean> {
    const t = this.tasks.get(taskId)
    if (!t) return false
    if (!canTx(t.status, status)) return false // 409 — illegal transition
    this.statusUpdates.push({ taskId, status })
    t.status = status
    if (status === 'todo') t.assigneeAgentId = null // released → re-claimable
    return true
  }
  async addComment(taskId: string, body: string): Promise<void> {
    this.comments.push({ taskId, body })
  }
  async getTask(taskId: string): Promise<TaskDetail | null> {
    const t = this.tasks.get(taskId)
    if (!t) return null
    const ancestors: { id: string }[] = []
    let cur = t.parentTaskId
    while (cur) {
      ancestors.push({ id: cur })
      cur = this.tasks.get(cur)?.parentTaskId ?? null
    }
    return { task: this.toBoardTask(t), comments: [], ancestors }
  }
  async createExecution(taskId: string): Promise<ExecutionRef | null> {
    const id = `exec-${++this.execN}`
    this.execs.set(id, taskId)
    return { id }
  }
  async completeExecution(execId: string, outcome: CompleteExecutionOutcome): Promise<void> {
    this.completed.push({ execId, outcome })
  }
  async linkDep(taskId: string, dependsOnTaskId: string): Promise<boolean> {
    const list = this.depMap.get(taskId) ?? []
    list.push(dependsOnTaskId)
    this.depMap.set(taskId, list)
    return true
  }
  async getReadyTasks(): Promise<BoardTask[]> {
    const out: BoardTask[] = []
    for (const t of this.tasks.values()) {
      if (t.status !== 'todo') continue
      const blockers = this.depMap.get(t.id) ?? []
      if (blockers.every((d) => this.tasks.get(d)?.status === 'done')) out.push(this.toBoardTask(t))
    }
    return out
  }
  async listTasks(): Promise<BoardTask[]> {
    return [...this.tasks.values()].map((t) => this.toBoardTask(t))
  }
  async cancelDependents(taskId: string): Promise<Array<{ id: string; title?: string }>> {
    const out: Array<{ id: string; title?: string }> = []
    const visit = (id: string): void => {
      for (const [depId, blockers] of this.depMap) {
        if (!blockers.includes(id)) continue
        const t = this.tasks.get(depId)
        if (t && (t.status === 'todo' || t.status === 'backlog')) {
          t.status = 'cancelled'
          this.statusUpdates.push({ taskId: t.id, status: 'cancelled' })
          out.push({ id: t.id, title: t.title })
          visit(depId)
        }
      }
    }
    visit(taskId)
    return out
  }

  // ── CascadeBoard inspection + control ──
  statusOf(taskId: string): string | undefined {
    return this.tasks.get(taskId)?.status
  }
  depsOf(taskId: string): readonly string[] {
    return this.depMap.get(taskId) ?? []
  }
  taskCount(): number {
    return this.tasks.size
  }
  allStatuses(): string[] {
    return [...this.tasks.values()].map((t) => t.status)
  }
  forceRelease(taskId: string): void {
    const t = this.tasks.get(taskId)
    if (t) {
      t.status = 'todo'
      t.assigneeAgentId = null
    }
  }
  seedInProgress(input: {
    title: string
    sourceDelegationId: string | null
    assigneeAgentId: string
  }): string {
    const id = `task-${++this.taskN}`
    this.tasks.set(id, {
      id,
      status: 'in_progress',
      parentTaskId: null,
      title: input.title,
      description: input.title,
      sourceDelegationId: input.sourceDelegationId,
      assigneeAgentId: input.assigneeAgentId,
    })
    return id
  }
  dispose(): void {
    // in-memory — nothing to release
  }
}

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
