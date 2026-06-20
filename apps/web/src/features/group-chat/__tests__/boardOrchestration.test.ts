import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeEvent } from '@clawboo/executor'

import {
  createBoardOrchestrator,
  extractSignals,
  DELEGATION_IDLE_TIMEOUT_MS,
  MAX_DELEGATION_FAILURES,
  MAX_SPAWN_DEPTH,
  REFLECT_WINDOW_MS,
  type BoardChange,
  type DelegationSignal,
  type KnownAgent,
} from '../boardOrchestration'
import type {
  BoardClient,
  BoardTask,
  ClaimResult,
  CompleteExecutionOutcome,
  CreateTaskInput,
  ExecutionRef,
  TaskDetail,
} from '@/lib/boardClient'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const KNOWN: KnownAgent[] = [
  { id: 'leader', name: 'Boo Zero' },
  { id: 'a2', name: 'Bug Boo' },
  { id: 'a3', name: 'Design Boo' },
  { id: 'a4', name: 'Test Boo' },
]

const sk = (id: string) => `agent:${id}:team:t1`
const agentIdForSession = (s: string) => s.match(/^agent:([^:]+):/)?.[1] ?? null

function doneEvent(runId: string, summary: string): RuntimeEvent {
  return { kind: 'done', reason: 'success', summary, runId, sessionId: null, ts: 1, seq: 1 }
}
function failedDoneEvent(
  runId: string,
  reason: 'error' | 'aborted' | 'max_turns',
  summary: string,
): RuntimeEvent {
  return { kind: 'done', reason, summary, runId, sessionId: null, ts: 1, seq: 1 }
}
function errorEvent(runId: string, message: string, fatal: boolean): RuntimeEvent {
  return { kind: 'error', code: null, message, fatal, runId, sessionId: null, ts: 1, seq: 1 }
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
// the fake REST board rejects an illegal transition exactly as the server's PATCH
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

class FakeBoard implements BoardClient {
  tasks = new Map<string, FakeRow>()
  deps = new Map<string, string[]>() // taskId → [dependsOnTaskId]
  comments: { taskId: string; body: string }[] = []
  statusUpdates: { taskId: string; status: string }[] = []
  claims: string[] = []
  execs = new Map<string, string>()
  completed: { execId: string; outcome: CompleteExecutionOutcome }[] = []
  forceClaimConflict = false
  onCreate?: () => void
  onClaim?: () => void
  private taskN = 0
  private execN = 0

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
    return this.toBoardTask(row)
  }
  async claim(taskId: string, assigneeAgentId?: string): Promise<ClaimResult> {
    this.onClaim?.()
    this.claims.push(taskId)
    if (this.forceClaimConflict) return { ok: false, reason: 'conflict' }
    const t = this.tasks.get(taskId)
    // Atomic-claim guard: only a `todo` + unassigned task can be claimed.
    if (!t || t.status !== 'todo' || t.assigneeAgentId) return { ok: false, reason: 'conflict' }
    t.status = 'in_progress'
    t.assigneeAgentId = assigneeAgentId ?? 'someone'
    return { ok: true, task: this.toBoardTask(t) }
  }
  async updateStatus(taskId: string, status: string): Promise<boolean> {
    const t = this.tasks.get(taskId)
    if (!t) return false
    if (!canTx(t.status, status)) return false // 409 — illegal transition, as the server PATCH
    this.statusUpdates.push({ taskId, status })
    t.status = status
    if (status === 'todo') t.assigneeAgentId = null // released → re-claimable (mirrors the server)
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
    const list = this.deps.get(taskId) ?? []
    list.push(dependsOnTaskId)
    this.deps.set(taskId, list)
    return true
  }
  async getReadyTasks(): Promise<BoardTask[]> {
    const out: BoardTask[] = []
    for (const t of this.tasks.values()) {
      if (t.status !== 'todo') continue
      const blockers = this.deps.get(t.id) ?? []
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
      for (const [depId, blockers] of this.deps) {
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
}

type DelegationResolution = 'allow_once' | 'allow_always' | 'deny' | 'expired' | 'timeout'
interface HarnessOpts {
  stopGen?: () => number
  caps?: { maxFanout?: number }
  onCapHit?: (info: { kind: 'fanout'; sourceTaskId: string | null }) => void
  isRiskyDelegation?: (sig: DelegationSignal) => boolean
  requestDelegationApproval?: (input: {
    leaderAgentId: string
    targetAgentId: string
    targetAgentName: string
    task: string
  }) => Promise<DelegationResolution>
  now?: () => number
  /** Override session resolution (return null to simulate an asleep / unknown agent). */
  sessionKeyForAgent?: (id: string) => string | null
  /** When set, `deliver` rejects for these target agent ids (delivery-failure tests). */
  deliverRejectsFor?: Set<string>
}

function makeHarness(opts?: HarnessOpts) {
  const board = new FakeBoard()
  const delivered: { sessionKey: string; agentId: string; task: string }[] = []
  const changes: BoardChange[] = []
  const narrations: { sessionKey: string; text: string }[] = []
  const orchestrator = createBoardOrchestrator({
    teamId: 't1',
    board,
    known: () => KNOWN,
    leaderAgentId: () => 'leader',
    sessionKeyForAgent: opts?.sessionKeyForAgent ?? ((id) => sk(id)),
    agentIdForSession,
    deliver: async (sessionKey, agentId, task) => {
      if (opts?.deliverRejectsFor?.has(agentId)) throw new Error('delivery rejected')
      delivered.push({ sessionKey, agentId, task })
    },
    stopGen: opts?.stopGen ?? (() => 0),
    onBoardChange: (c) => changes.push(c),
    narrate: (sessionKey, text) => narrations.push({ sessionKey, text }),
    ...(opts?.caps ? { caps: opts.caps } : {}),
    ...(opts?.onCapHit ? { onCapHit: opts.onCapHit } : {}),
    ...(opts?.isRiskyDelegation ? { isRiskyDelegation: opts.isRiskyDelegation } : {}),
    ...(opts?.requestDelegationApproval
      ? { requestDelegationApproval: opts.requestDelegationApproval }
      : {}),
    ...(opts?.now ? { now: opts.now } : {}),
  })
  return { board, delivered, changes, narrations, orchestrator }
}

// Fake timers gate ONLY the reflection batcher's debounce; promise/microtask
// chains (the board calls) still resolve when awaited.
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

const reflections = (delivered: Array<{ sessionKey: string; agentId: string; task: string }>) =>
  delivered.filter((d) => d.task.startsWith('[Task Update]'))

// ─── Governance: orchestrator caps + approval plumbing ────

describe('createBoardOrchestrator — governance caps + approval', () => {
  const TWO_DELEGATIONS =
    '<delegate to="@Bug Boo">a</delegate><delegate to="@Design Boo">b</delegate>'

  it('caps fan-out per turn (drops the overflow + fires onCapHit)', async () => {
    const capHits: { kind: string }[] = []
    const { board, delivered, orchestrator } = makeHarness({
      caps: { maxFanout: 1 },
      onCapHit: (i) => capHits.push(i),
    })
    await orchestrator.onEvent(sk('leader'), doneEvent('r1', TWO_DELEGATIONS))
    expect(board.tasks.size).toBe(1) // only the first spawned
    expect(delivered).toHaveLength(1)
    expect(capHits).toHaveLength(1)
  })

  it('without caps, fan-out is unbounded (byte-identity to flag-off)', async () => {
    const { board, orchestrator } = makeHarness()
    await orchestrator.onEvent(sk('leader'), doneEvent('r1', TWO_DELEGATIONS))
    expect(board.tasks.size).toBe(2)
  })

  it('a risky delegation DENIED at the approval gate is never created or delivered', async () => {
    const { board, delivered, orchestrator } = makeHarness({
      isRiskyDelegation: () => true,
      requestDelegationApproval: async () => 'deny',
    })
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">delete prod</delegate>'),
    )
    expect(board.tasks.size).toBe(0)
    expect(delivered).toEqual([])
  })

  it('a forgotten approval (timeout / expired) blocks delivery — no deadlock', async () => {
    for (const resolution of ['timeout', 'expired'] as const) {
      const { board, delivered, orchestrator } = makeHarness({
        isRiskyDelegation: () => true,
        requestDelegationApproval: async () => resolution,
      })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('rX', '<delegate to="@Bug Boo">x</delegate>'),
      )
      expect(board.tasks.size).toBe(0)
      expect(delivered).toEqual([])
    }
  })

  it('an APPROVED risky delegation proceeds normally', async () => {
    const { board, delivered, orchestrator } = makeHarness({
      isRiskyDelegation: () => true,
      requestDelegationApproval: async () => 'allow_once',
    })
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">deploy</delegate>'),
    )
    expect(board.tasks.size).toBe(1)
    expect(delivered).toHaveLength(1)
  })

  it('a NON-risky delegation skips the approval gate entirely', async () => {
    let asked = 0
    const { board, delivered, orchestrator } = makeHarness({
      isRiskyDelegation: () => false,
      requestDelegationApproval: async () => {
        asked += 1
        return 'deny'
      },
    })
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">summarize</delegate>'),
    )
    expect(asked).toBe(0)
    expect(board.tasks.size).toBe(1)
    expect(delivered).toHaveLength(1)
  })
})

// ─── extractSignals (structured-only) ────────────────────────────────────────

describe('extractSignals', () => {
  it('reads a sessions_send tool-call as a parallel delegation', () => {
    const ev = toolCallEvent('r1', 'sessions_send', { label: 'Bug Boo', message: 'fix the bug' })
    const out = extractSignals(ev, 'leader', KNOWN)
    expect(out.parallel).toEqual([
      { targetAgentId: 'a2', targetAgentName: 'Bug Boo', task: 'fix the bug' },
    ])
    expect(out.plan).toEqual([])
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
    // The "kill the regex" guarantee: prose like "@Bug Boo, please fix" produces
    // NO signal — only structured directives route.
    const ev = doneEvent('r1', '@Bug Boo, please fix the bug when you get a chance.')
    const out = extractSignals(ev, 'leader', KNOWN)
    expect(out.parallel).toEqual([])
    expect(out.plan).toEqual([])
  })
})

// ─── createBoardOrchestrator: derive ──────────────────────────────────────────

describe('createBoardOrchestrator — derive', () => {
  it('turns a leader delegation into a claimed board task + delivery', async () => {
    const { board, delivered, orchestrator } = makeHarness()
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">fix it</delegate>'),
    )
    expect(board.tasks.size).toBe(1)
    expect(board.claims).toHaveLength(1)
    expect(board.execs.size).toBe(1)
    expect(delivered).toEqual([{ sessionKey: sk('a2'), agentId: 'a2', task: 'fix it' }])
  })

  it('fans out ≥2 structured delegations into N parallel tasks', async () => {
    const { board, delivered, orchestrator } = makeHarness()
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent(
        'r1',
        '<delegate to="@Bug Boo">a</delegate><delegate to="@Design Boo">b</delegate>',
      ),
    )
    expect(board.tasks.size).toBe(2)
    expect(delivered.map((d) => d.agentId).sort()).toEqual(['a2', 'a3'])
  })

  it('does not retry a claim conflict (409) — no execution, no delivery', async () => {
    const { board, delivered, orchestrator } = makeHarness()
    board.forceClaimConflict = true
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">x</delegate>'),
    )
    expect(board.claims).toHaveLength(1)
    expect(board.execs.size).toBe(0)
    expect(delivered).toEqual([])
  })

  it(`enforces MAX_SPAWN_DEPTH (${MAX_SPAWN_DEPTH}) via the board ancestor chain`, async () => {
    const { board, delivered, orchestrator } = makeHarness()
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">t1</delegate>'),
    )
    await orchestrator.onEvent(
      sk('a2'),
      doneEvent('r2', '<delegate to="@Design Boo">t2</delegate>'),
    )
    await orchestrator.onEvent(sk('a3'), doneEvent('r3', '<delegate to="@Test Boo">t3</delegate>'))
    await orchestrator.onEvent(sk('a4'), doneEvent('r4', '<delegate to="@Bug Boo">t4</delegate>'))

    expect(board.tasks.size).toBe(3)
    expect(delivered).toHaveLength(3)
    expect(board.comments.some((c) => c.taskId === 'task-3' && /depth limit/i.test(c.body))).toBe(
      true,
    )
  })

  it('dedupes the same delegation seen twice (idempotent re-observation)', async () => {
    const { board, orchestrator } = makeHarness()
    const ev = doneEvent('r1', '<delegate to="@Bug Boo">once</delegate>')
    await orchestrator.onEvent(sk('leader'), ev)
    await orchestrator.onEvent(sk('leader'), ev)
    expect(board.tasks.size).toBe(1)
  })

  it('bails before delivery when the stop generation changes mid-spawn', async () => {
    let gen = 0
    const { board, delivered, orchestrator } = makeHarness({ stopGen: () => gen })
    board.onCreate = () => {
      gen += 1
    }
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">x</delegate>'),
    )
    expect(board.tasks.size).toBe(1)
    expect(delivered).toEqual([])
  })
})

// ─── round-trip: completion + report-up ───────────────────────────────────────

describe('createBoardOrchestrator — round-trip', () => {
  it('marks a task done + records the summary as a report-up comment on child completion', async () => {
    const { board, orchestrator } = makeHarness()
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">fix it</delegate>'),
    )
    await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'Fixed it — patched auth.ts.'))
    expect(board.statusUpdates).toContainEqual({ taskId: 'task-1', status: 'done' })
    expect(board.completed).toHaveLength(1)
    expect(board.completed[0]!.outcome.status).toBe('succeeded')
    expect(board.comments.some((c) => c.taskId === 'task-1' && c.body.includes('Fixed it'))).toBe(
      true,
    )
  })

  it('emits board changes for the projection store (created → claimed → done)', async () => {
    const { changes, orchestrator } = makeHarness()
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">fix</delegate>'),
    )
    expect(changes.some((c) => c.status === 'todo')).toBe(true)
    expect(changes.some((c) => c.status === 'in_progress' && c.assigneeAgentId === 'a2')).toBe(true)
    await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'done summary'))
    expect(changes.some((c) => c.status === 'done' && c.summary === 'done summary')).toBe(true)
  })
})

// ─── reflect: board → chat ────────────────────────────────────────────────────

describe('createBoardOrchestrator — reflect', () => {
  it('batches completed tasks into one [Task Update] delivered to the leader', async () => {
    const { delivered, narrations, orchestrator } = makeHarness()
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent(
        'r1',
        '<delegate to="@Bug Boo">a</delegate><delegate to="@Design Boo">b</delegate>',
      ),
    )
    await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'A is done'))
    await orchestrator.onEvent(sk('a3'), doneEvent('r3', 'B is done'))
    // Nothing reflected before the debounce window elapses.
    expect(reflections(delivered)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const refl = reflections(delivered)
    expect(refl).toHaveLength(1)
    expect(refl[0]!.sessionKey).toBe(sk('leader'))
    expect(refl[0]!.agentId).toBe('leader')
    expect(refl[0]!.task).toContain('A is done')
    expect(refl[0]!.task).toContain('B is done')
    // Also narrated into the chat for visibility.
    expect(
      narrations.some((n) => n.sessionKey === sk('leader') && n.text.startsWith('[Task Update]')),
    ).toBe(true)
  })

  it('a leader done emits no board mutation and no reflection (echo-loop guard)', async () => {
    const { board, delivered, orchestrator } = makeHarness()
    // The leader's synthesis turn — it is never in sessionToTask.
    await orchestrator.onEvent(sk('leader'), doneEvent('rL', 'Here is the combined synthesis.'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(board.statusUpdates).toHaveLength(0)
    expect(reflections(delivered)).toHaveLength(0)
  })
})

// ─── failure feedback: the "leader left standing" fix ─────────────────────────

describe('createBoardOrchestrator — failure feedback', () => {
  /** Delegate `fix it` to Bug Boo (a2) and return the harness. */
  async function delegate(h: ReturnType<typeof makeHarness>) {
    await h.orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">fix it</delegate>'),
    )
    return h
  }

  it('an errored child done blocks the task, fails the execution, and reflects a FAILURE to the leader', async () => {
    const { board, delivered, orchestrator } = await delegate(makeHarness())
    await orchestrator.onEvent(sk('a2'), failedDoneEvent('r2', 'error', 'TypeError: cannot read x'))

    expect(board.statusUpdates).toContainEqual({ taskId: 'task-1', status: 'blocked' })
    expect(board.completed).toHaveLength(1)
    expect(board.completed[0]!.outcome.status).toBe('failed')
    expect(board.completed[0]!.outcome.error).toContain('TypeError')
    expect(board.comments.some((c) => c.taskId === 'task-1' && /Run failed/i.test(c.body))).toBe(
      true,
    )

    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const refl = reflections(delivered)
    expect(refl).toHaveLength(1)
    expect(refl[0]!.sessionKey).toBe(sk('leader'))
    expect(refl[0]!.task).toMatch(/DID NOT COMPLETE/)
    expect(refl[0]!.task).toContain('TypeError')
    // NOT recorded as a success.
    expect(board.completed[0]!.outcome.status).not.toBe('succeeded')
    expect(board.statusUpdates).not.toContainEqual({ taskId: 'task-1', status: 'done' })
  })

  it('an aborted child done closes the execution as cancelled', async () => {
    const { board, orchestrator } = await delegate(makeHarness())
    await orchestrator.onEvent(sk('a2'), failedDoneEvent('r2', 'aborted', ''))
    expect(board.completed[0]!.outcome.status).toBe('cancelled')
    expect(board.statusUpdates).toContainEqual({ taskId: 'task-1', status: 'blocked' })
  })

  it('a fatal error event fails the delegation and reflects it', async () => {
    const { board, delivered, orchestrator } = await delegate(makeHarness())
    await orchestrator.onEvent(sk('a2'), errorEvent('r2', 'gateway exploded', true))
    expect(board.statusUpdates).toContainEqual({ taskId: 'task-1', status: 'blocked' })
    expect(board.completed[0]!.outcome.status).toBe('failed')
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(reflections(delivered)[0]!.task).toMatch(/DID NOT COMPLETE/)
  })

  it('a NON-fatal error keeps waiting — no block, no completion, no reflection', async () => {
    const { board, delivered, orchestrator } = await delegate(makeHarness())
    await orchestrator.onEvent(sk('a2'), errorEvent('r2', 'transient blip', false))
    expect(board.statusUpdates).toHaveLength(0) // claim sets in_progress directly; no done/blocked
    expect(board.completed).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(reflections(delivered)).toHaveLength(0)
  })

  it('the watchdog fails a delegate that goes silent past the timeout', async () => {
    let clock = 1_000
    const h = makeHarness({ now: () => clock })
    await delegate(h)
    const { board, delivered, orchestrator } = h

    // Just under the window → not yet stale.
    clock += DELEGATION_IDLE_TIMEOUT_MS - 1
    await orchestrator.sweepStaleSessions()
    expect(board.statusUpdates.some((s) => s.status === 'blocked')).toBe(false)

    // Past the window → swept.
    clock += 2
    await orchestrator.sweepStaleSessions()
    expect(board.statusUpdates).toContainEqual({ taskId: 'task-1', status: 'blocked' })
    expect(board.completed[0]!.outcome.status).toBe('timed_out')
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(reflections(delivered)[0]!.task).toMatch(/DID NOT COMPLETE/)
  })

  it('does NOT sweep a delegate that keeps emitting events (activity refreshed)', async () => {
    let clock = 1_000
    const h = makeHarness({ now: () => clock })
    await delegate(h)
    const { board, orchestrator } = h

    clock += DELEGATION_IDLE_TIMEOUT_MS - 1
    // The delegate is alive — a tool-call refreshes its activity clock.
    await orchestrator.onEvent(sk('a2'), toolCallEvent('r2', 'read_file', { path: 'x' }))
    clock += DELEGATION_IDLE_TIMEOUT_MS - 1
    await orchestrator.sweepStaleSessions()
    expect(board.statusUpdates.some((s) => s.status === 'blocked')).toBe(false)
  })

  it('onSessionClosed fails a still-in-flight delegation; later calls are no-ops', async () => {
    const { board, orchestrator } = await delegate(makeHarness())
    await orchestrator.onSessionClosed(sk('a2'))
    expect(board.statusUpdates).toContainEqual({ taskId: 'task-1', status: 'blocked' })
    const n = board.statusUpdates.length
    await orchestrator.onSessionClosed(sk('a2')) // now unmapped
    expect(board.statusUpdates).toHaveLength(n)
  })

  it('a late completion after a fired timeout is a harmless no-op', async () => {
    let clock = 1_000
    const h = makeHarness({ now: () => clock })
    await delegate(h)
    const { board, orchestrator } = h

    clock += DELEGATION_IDLE_TIMEOUT_MS + 1
    await orchestrator.sweepStaleSessions()
    expect(board.statusUpdates).toContainEqual({ taskId: 'task-1', status: 'blocked' })
    const completedCount = board.completed.length

    // The delegate finally responds — but it is already failed + unmapped.
    await orchestrator.onEvent(sk('a2'), doneEvent('rLate', 'oh I finished'))
    expect(board.statusUpdates).not.toContainEqual({ taskId: 'task-1', status: 'done' })
    expect(board.completed).toHaveLength(completedCount)
  })
})

// ─── coordination contract: never leave the delegator standing ────────────────

describe('createBoardOrchestrator — coordination contract', () => {
  it('reflects a failure when the delegation target has no active session', async () => {
    const { board, delivered, orchestrator } = makeHarness({
      sessionKeyForAgent: (id) => (id === 'a3' ? null : sk(id)),
    })
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Design Boo">do it</delegate>'),
    )
    expect(board.tasks.size).toBe(0) // never created
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const refl = reflections(delivered)
    expect(refl).toHaveLength(1)
    expect(refl[0]!.sessionKey).toBe(sk('leader')) // the delegator (leader at depth 0) is told
    expect(refl[0]!.task).toMatch(/DID NOT COMPLETE/)
    expect(refl[0]!.task).toMatch(/no active session/i)
  })

  it('reflects a deliverable-only completion (empty summary) instead of dropping it', async () => {
    const { delivered, orchestrator } = makeHarness()
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">write the file</delegate>'),
    )
    await orchestrator.onEvent(sk('a2'), doneEvent('r2', '')) // empty summary — the deliverable IS the output
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const refl = reflections(delivered)
    expect(refl).toHaveLength(1)
    expect(refl[0]!.sessionKey).toBe(sk('leader'))
    expect(refl[0]!.task).toMatch(/produced a deliverable|completed/i)
  })

  it('reports a sub-task result to its IMMEDIATE parent (reduce-point), not only the leader', async () => {
    const { delivered, orchestrator } = makeHarness()
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
    )
    // a2 completes its task AND sub-delegates to a3 (a3's result must go back to a2).
    await orchestrator.onEvent(
      sk('a2'),
      doneEvent('r2', 'top done. <delegate to="@Design Boo">sub task</delegate>'),
    )
    await orchestrator.onEvent(sk('a3'), doneEvent('r3', 'sub result here'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const refl = reflections(delivered)
    const toA2 = refl.find((r) => r.sessionKey === sk('a2'))
    expect(toA2).toBeTruthy()
    expect(toA2!.task).toContain('sub result here')
    expect(refl.some((r) => r.sessionKey === sk('leader'))).toBe(true) // top result still goes to the leader
  })

  it('cancels the dead downstream chain when a plan step fails (no ghost todo)', async () => {
    const { board, delivered, orchestrator } = makeHarness()
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('rp', '<plan><step to="@Bug Boo">s1</step><step to="@Design Boo">s2</step></plan>'),
    )
    expect(board.tasks.size).toBe(2)
    await orchestrator.onEvent(sk('a2'), failedDoneEvent('r2', 'error', 'boom'))
    expect(board.statusUpdates).toContainEqual({ taskId: 'task-1', status: 'blocked' })
    expect(board.statusUpdates).toContainEqual({ taskId: 'task-2', status: 'cancelled' }) // dependent cancelled
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(reflections(delivered)[0]!.task).toMatch(/cancelled/i)
  })

  it('nudges the leader once per run when a delegation tag did not parse (loop-safe, but re-nudges a NEW run)', async () => {
    const { board, delivered, orchestrator } = makeHarness()
    const malformed = doneEvent('r1', 'On it. <delegate to="@Bug Boo">do the thing (never closed')
    await orchestrator.onEvent(sk('a2'), malformed)
    expect(board.tasks.size).toBe(0)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const first = reflections(delivered)
    expect(first).toHaveLength(1)
    expect(first[0]!.sessionKey).toBe(sk('leader'))
    expect(first[0]!.task).toMatch(/didn't parse|re-issue/i)
    // Re-observing the SAME run must NOT re-nudge (idempotent within a run).
    await orchestrator.onEvent(sk('a2'), malformed)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(reflections(delivered)).toHaveLength(1)
    // A genuinely-NEW run that also fails to parse SHOULD re-nudge — a distinct
    // later failure must not be silently swallowed (the per-(run,agent) key fix).
    await orchestrator.onEvent(
      sk('a2'),
      doneEvent('r2', 'Trying again <delegate to="@Bug Boo">still broken'),
    )
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(reflections(delivered)).toHaveLength(2)
  })

  it('fails the task immediately when delivery is rejected (no 8-minute wait)', async () => {
    const { board, delivered, orchestrator } = makeHarness({ deliverRejectsFor: new Set(['a2']) })
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">do it</delegate>'),
    )
    expect(board.statusUpdates).toContainEqual({ taskId: 'task-1', status: 'blocked' })
    expect(delivered.filter((d) => d.agentId === 'a2')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(reflections(delivered)[0]!.task).toMatch(/DID NOT COMPLETE/)
  })

  it('reflects a fan-out cap overflow to the delegator (work not silently dropped)', async () => {
    const { delivered, orchestrator } = makeHarness({ caps: { maxFanout: 1 } })
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent(
        'r1',
        '<delegate to="@Bug Boo">a</delegate><delegate to="@Design Boo">b</delegate>',
      ),
    )
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(
      reflections(delivered).some(
        (r) => r.sessionKey === sk('leader') && /not started|cap/i.test(r.task),
      ),
    ).toBe(true)
  })

  it('a successful completion emits a visible "✓ completed" narration (done ≠ stuck)', async () => {
    const { narrations, orchestrator } = makeHarness()
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">fix it</delegate>'),
    )
    await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'fixed'))
    expect(narrations.some((n) => /✓.*completed/.test(n.text))).toBe(true)
  })
})

// ─── plans: durable deps + auto-unblock ready-pump ────────────────────────────

describe('createBoardOrchestrator — plans / auto-unblock', () => {
  it('chains plan steps via deps and fires step 2 only after step 1 completes', async () => {
    const { board, delivered, orchestrator } = makeHarness()
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('rp', '<plan><step to="@Bug Boo">s1</step><step to="@Design Boo">s2</step></plan>'),
    )
    // Both step tasks exist; step 2 depends on step 1.
    expect(board.tasks.size).toBe(2)
    expect(board.deps.get('task-2')).toEqual(['task-1'])
    // Only step 1 is ready → only it is delivered.
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ agentId: 'a2', task: 's1' })

    // Step 1 completes → step 2 auto-unblocks and fires.
    await orchestrator.onEvent(sk('a2'), doneEvent('rp2', 'step one done'))
    expect(delivered).toHaveLength(2)
    expect(delivered[1]).toMatchObject({ agentId: 'a3', task: 's2' })
  })
})

// ─── coordination hardening (adversarial-review fixes) ────────────────────────

describe('createBoardOrchestrator — coordination hardening', () => {
  const deliveredTo = (
    delivered: Array<{ agentId: string; task: string }>,
    agentId: string,
  ): string[] => delivered.filter((d) => d.agentId === agentId).map((d) => d.task)

  it('serializes two delegations to the SAME agent — both run in order, neither orphaned', async () => {
    const { board, delivered, orchestrator } = makeHarness()
    // The leader delegates Bug Boo (a2) TWO distinct tasks in one turn.
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent(
        'r1',
        '<delegate to="@Bug Boo">task A</delegate><delegate to="@Bug Boo">task B</delegate>',
      ),
    )
    // Both board tasks exist; only task A is delivered (the agent's single session
    // is busy — task B is DEFERRED, not an overwrite of the session mapping).
    expect(board.tasks.size).toBe(2)
    expect(deliveredTo(delivered, 'a2')).toEqual(['task A'])

    // task A completes → task B auto-fires from the ready-pump.
    await orchestrator.onEvent(sk('a2'), doneEvent('rA', 'A done'))
    expect(deliveredTo(delivered, 'a2')).toEqual(['task A', 'task B'])

    // task B completes → BOTH tasks are done; the first was never orphaned.
    await orchestrator.onEvent(sk('a2'), doneEvent('rB', 'B done'))
    expect([...board.tasks.values()].map((t) => t.status)).toEqual(['done', 'done'])
  })

  it('does NOT fake-complete a task released out from under it (server stale-sweep race)', async () => {
    const { board, delivered, orchestrator } = makeHarness()
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">long task</delegate>'),
    )
    // The server stale-sweep releases the (long-running) task back to todo.
    board.tasks.get('task-1')!.status = 'todo'
    board.tasks.get('task-1')!.assigneeAgentId = null
    // The delegate finally completes — but the task is no longer ours.
    await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'finally done'))
    // It must NOT be marked done (todo→done is illegal) and must NOT report success.
    expect(board.tasks.get('task-1')!.status).toBe('todo')
    expect(board.statusUpdates).not.toContainEqual({ taskId: 'task-1', status: 'done' })
    // The orphaned exec is closed as cancelled; the delegator is told it landed late.
    expect(board.completed.some((c) => c.outcome.status === 'cancelled')).toBe(true)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(
      reflections(delivered).some((r) => /released\/reassigned|not recorded/i.test(r.task)),
    ).toBe(true)
  })

  it('a user Stop (aborted terminal after stopGen bump) releases the task — no block, no cancel, no failure reflection', async () => {
    let gen = 0
    const { board, delivered, orchestrator } = makeHarness({ stopGen: () => gen })
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('rp', '<plan><step to="@Bug Boo">s1</step><step to="@Design Boo">s2</step></plan>'),
    )
    expect(board.tasks.size).toBe(2)
    // User presses Stop → gen bumps → step 1 emits an aborted terminal.
    gen = 1
    await orchestrator.onEvent(sk('a2'), failedDoneEvent('r2', 'aborted', ''))
    // step 1 is RELEASED to todo (re-runnable), NOT blocked; step 2 is NOT cancelled.
    expect(board.tasks.get('task-1')!.status).toBe('todo')
    expect(board.statusUpdates).not.toContainEqual({ taskId: 'task-1', status: 'blocked' })
    expect(board.tasks.get('task-2')!.status).not.toBe('cancelled')
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(reflections(delivered).some((r) => /DID NOT COMPLETE/.test(r.task))).toBe(false)
  })

  it('a genuine abort (no Stop) still blocks + reflects (Stop distinction does not weaken real failures)', async () => {
    const { board, delivered, orchestrator } = makeHarness() // stopGen stays 0
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">fix it</delegate>'),
    )
    await orchestrator.onEvent(sk('a2'), failedDoneEvent('r2', 'aborted', ''))
    expect(board.statusUpdates).toContainEqual({ taskId: 'task-1', status: 'blocked' })
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(reflections(delivered).some((r) => /DID NOT COMPLETE/.test(r.task))).toBe(true)
  })

  it('a late done carrying a <delegate> after a fired timeout does NOT spawn an orphan task', async () => {
    let clock = 1_000
    const h = makeHarness({ now: () => clock })
    const { board, orchestrator } = h
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">task</delegate>'),
    )
    expect(board.tasks.size).toBe(1)
    // Watchdog fires (8 min silence) → task blocked + session unmapped + recently-terminated.
    clock += DELEGATION_IDLE_TIMEOUT_MS + 1
    await orchestrator.sweepStaleSessions()
    expect(board.statusUpdates).toContainEqual({ taskId: 'task-1', status: 'blocked' })
    // The delegate finally responds with a NEW <delegate> — it must NOT spawn a 2nd task.
    await orchestrator.onEvent(
      sk('a2'),
      doneEvent('rLate', 'Sorry. <delegate to="@Design Boo">orphan</delegate>'),
    )
    expect(board.tasks.size).toBe(1)
  })

  it('refuses to re-delegate after MAX_DELEGATION_FAILURES and tells the leader once', async () => {
    const { board, delivered, orchestrator } = makeHarness()
    // Fail the SAME (agent, task) MAX times.
    for (let i = 0; i < MAX_DELEGATION_FAILURES; i++) {
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent(`r${i}`, '<delegate to="@Bug Boo">flaky task</delegate>'),
      )
      await orchestrator.onEvent(sk('a2'), failedDoneEvent(`rc${i}`, 'error', 'boom'))
    }
    const tasksAfterMax = board.tasks.size
    // The (MAX+1)th delegation of the SAME task to the SAME agent is REFUSED.
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('rFinal', '<delegate to="@Bug Boo">flaky task</delegate>'),
    )
    expect(board.tasks.size).toBe(tasksAfterMax) // no new task created
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(
      reflections(delivered).some((r) =>
        /failed .* times|no longer re-delegating|handle it directly/i.test(r.task),
      ),
    ).toBe(true)
  })

  it('a successful completion RESETS the loop breaker for that (agent, task)', async () => {
    const { board, orchestrator } = makeHarness()
    // Two failures, then a success, then it can be delegated again.
    for (let i = 0; i < 2; i++) {
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent(`rf${i}`, '<delegate to="@Bug Boo">retry me</delegate>'),
      )
      await orchestrator.onEvent(sk('a2'), failedDoneEvent(`rcf${i}`, 'error', 'boom'))
    }
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('rok', '<delegate to="@Bug Boo">retry me</delegate>'),
    )
    await orchestrator.onEvent(sk('a2'), doneEvent('rcok', 'done at last'))
    const sizeBefore = board.tasks.size
    // After the success, the same delegation is allowed again (counter reset).
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('ragain', '<delegate to="@Bug Boo">retry me</delegate>'),
    )
    expect(board.tasks.size).toBe(sizeBefore + 1)
  })

  it('releases (not ghosts) a plan step when Stop fires between claim and deliver', async () => {
    let gen = 0
    const { board, delivered, orchestrator } = makeHarness({ stopGen: () => gen })
    await orchestrator.onEvent(
      sk('leader'),
      doneEvent('rp', '<plan><step to="@Bug Boo">s1</step><step to="@Design Boo">s2</step></plan>'),
    )
    // Stop right as step 1 completes → pumpReady → fireTask(step 2) bumps gen mid-claim.
    board.onClaim = () => {
      gen = 1
      board.onClaim = undefined // only trip once
    }
    await orchestrator.onEvent(sk('a2'), doneEvent('rp2', 's1 done'))
    // step 2 was claimed then released to todo — NOT a permanent in_progress ghost,
    // and NOT delivered after the Stop.
    expect(board.tasks.get('task-2')!.status).toBe('todo')
    expect(deliveredTo(delivered, 'a3')).toEqual([])
  })

  it('recovers the reduce-point from the persisted id on resume (mid-chain delegator, not the leader)', async () => {
    const { board, delivered, orchestrator } = makeHarness()
    // Pre-seed an in_progress sub-task whose sdid encodes a2 as the delegator
    // (a refresh: in-memory maps are empty; only the durable row survives).
    board.tasks.set('task-9', {
      id: 'task-9',
      status: 'in_progress',
      parentTaskId: null,
      title: 'sub task',
      description: 'sub task',
      sourceDelegationId: 'rX:deleg:reflectTo:a2',
      assigneeAgentId: 'a3',
    })
    await orchestrator.resume()
    // a3 completes the resumed task → its result reflects to a2 (the decoded
    // delegator), NOT the leader.
    await orchestrator.onEvent(sk('a3'), doneEvent('r3', 'sub done'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const refl = reflections(delivered)
    expect(refl.some((r) => r.sessionKey === sk('a2'))).toBe(true)
    expect(refl.some((r) => r.sessionKey === sk('leader'))).toBe(false)
  })
})
