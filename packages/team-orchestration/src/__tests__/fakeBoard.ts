// The in-memory reference board the engine's tests run against. It enforces the
// REAL transition rules (@clawboo/board-core, the same module @clawboo/db enforces
// inside its write transaction) and records every call, so a test can assert what
// the engine asked the board to do. Shared by the cascade contract run
// (boardOrchestration.test.ts) and the engine's own scenario tests.

import { canTransition, isTaskStatus } from '@clawboo/board-core'

import type {
  BoardTask,
  ClaimResult,
  CompleteExecutionOutcome,
  CreateTaskInput,
  ExecutionRef,
  TaskDetail,
} from '../boardClient'
import type { CascadeBoard, SeedExecState } from '../contract'

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

// The fake rejects an illegal transition exactly as the real repo's updateStatus
// does (e.g. a `todo → done` after the task was released out from under a client),
// by consulting the shared rulebook rather than a hand-copied table. `status` is a
// plain string on the row, so an off-list value is only ever a same-status no-op.
const canTx = (from: string, to: string): boolean =>
  from === to || (isTaskStatus(from) && isTaskStatus(to) && canTransition(from, to))

export class FakeBoard implements CascadeBoard {
  tasks = new Map<string, FakeRow>()
  depMap = new Map<string, string[]>() // taskId → [dependsOnTaskId]
  comments: { taskId: string; body: string }[] = []
  statusUpdates: { taskId: string; status: string }[] = []
  claims: string[] = []
  execs = new Map<string, string>()
  /** execId → executorType, when it is NOT the engine's own 'openclaw' fire. */
  execTypes = new Map<string, string>()
  completed: { execId: string; outcome: CompleteExecutionOutcome }[] = []
  created: BoardTask[] = []
  forceClaimConflict = false
  onCreate?: () => void
  onClaim?: () => void
  private taskN = 0
  private execN = 0

  /** Seeded rows are pre-existing state, not executions the ENGINE opened:
   *  `RealCascadeBoard` increments only in createExecution, and the contract's
   *  exec-count assertions mean "how many runs did the engine start". */
  private seededExecs = new Set<string>()

  get execCount(): number {
    let n = 0
    for (const id of this.execs.keys()) if (!this.seededExecs.has(id)) n += 1
    return n
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
  async listExecutions(
    taskId: string,
  ): Promise<Array<{ id: string; status: string; executorType?: string }>> {
    // Derive the ledger from the recorded calls: every exec opened for the task,
    // in id order; a completed one carries its outcome status, else 'running'.
    // Engine-created execs are 'openclaw' (fireTask/spawn), matching the real
    // board — resume()'s ownership gate keys on it.
    const rows: Array<{ id: string; status: string; executorType?: string }> = []
    for (const [id, tid] of this.execs) {
      if (tid !== taskId) continue
      const done = this.completed.find((c) => c.execId === id)
      rows.push({
        id,
        status: done ? done.outcome.status : 'running',
        executorType: this.execTypes.get(id) ?? 'openclaw',
      })
    }
    return rows
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
    exec?: SeedExecState
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
    // A refresh scenario normally has a live ENGINE run behind the row; the
    // other two shapes exist so the resume guards are actually exercised.
    const exec = input.exec ?? 'running-openclaw'
    if (exec !== 'none') {
      const execId = `exec-${++this.execN}`
      this.execs.set(execId, id)
      this.seededExecs.add(execId)
      if (exec === 'running-executor') this.execTypes.set(execId, 'codex')
    }
    return id
  }
  dispose(): void {
    // in-memory — nothing to release
  }
}
