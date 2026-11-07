// The in-memory reference board the engine's tests run against. It enforces the
// REAL transition rules (@clawboo/board-core, the same module @clawboo/db enforces
// inside its write transaction) and records every call, so a test can assert what
// the engine asked the board to do. Shared by the cascade contract run
// (boardOrchestration.test.ts) and the engine's own scenario tests.

import {
  canTransition,
  delegationTargetOf,
  delegatorOf,
  HAND_OFF_TITLE_CHARS,
  isTaskStatus,
  ledgerWillAutoFire,
  normalizeTaskTitle,
  parseResultClaim,
  strongerWakeReason,
  subtaskWaitOver,
  tallySubtasks,
  unfinishedNeed,
  unfinishedSubtasks,
  waitsOnOtherWork,
  type HandOffLink,
  type ResultClaim,
  type SubtaskView,
  type WaitingOn,
} from '@clawboo/board-core'
import {
  DEFAULT_MAX_CHILDREN,
  DEFAULT_MAX_ROOT_CREATES,
  DEFAULT_ROOT_CREATE_WINDOW_MS,
} from '@clawboo/governance'

import type {
  BoardTask,
  ClaimedWake,
  ClaimResult,
  CompleteExecutionOutcome,
  CreateTaskInput,
  ExecutionRef,
  ExecutionSummary,
  HandOffCapacity,
  HandOffInput,
  HandOffResult,
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
  createdAt?: number
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
  /** execId → its engine marker, when it is not the engine's own (1). */
  execMarks = new Map<string, number | null>()
  completed: { execId: string; outcome: CompleteExecutionOutcome }[] = []
  created: BoardTask[] = []
  forceClaimConflict = false
  onCreate?: () => void
  onClaim?: () => void
  private taskN = 0
  private execN = 0
  /** Why each run started, and when it opened and closed, as the ledger records them. */
  readonly execReasons = new Map<string, string | null>()
  readonly execOpened = new Map<string, number>()
  readonly execClosed = new Map<string, number>()
  /** Comments as the board stores them: what the engine reads back on a task. */
  readonly commentRows: Array<{ taskId: string; body: string; kind: string; createdAt: number }> =
    []
  /** A sub-task created under a task, on the board rather than through the engine. */
  addSubTask(parentTaskId: string, title: string): string {
    const id = `task-${++this.taskN}`
    this.tasks.set(id, {
      id,
      status: 'todo',
      parentTaskId,
      title,
      description: title,
      sourceDelegationId: null,
      assigneeAgentId: null,
      createdAt: Date.now(),
    })
    return id
  }

  /** Seeded rows are pre-existing state, not executions the ENGINE opened:
   *  `RealCascadeBoard` increments only in createExecution, and the contract's
   *  exec-count assertions mean "how many runs did the engine start". */
  private seededExecs = new Set<string>()

  get execCount(): number {
    let n = 0
    for (const id of this.execs.keys()) if (!this.seededExecs.has(id)) n += 1
    return n
  }

  /** Wakes the board saved for a task, handed to the next claim. */
  private savedWakes = new Map<string, ClaimedWake[]>()
  private claimReasons = new Map<string, string>()
  private wakeN = 0
  /** Claims by execution, as `report_result` stores them. */
  private claimsByExec = new Map<string, ResultClaim>()

  seedResultClaim(taskId: string, claim: ResultClaim): void {
    const open = [...this.execs].filter(([, tid]) => tid === taskId).at(-1)?.[0]
    if (open) this.claimsByExec.set(open, claim)
  }
  async resultClaim(execId: string): Promise<ResultClaim | null> {
    return parseResultClaim(this.claimsByExec.get(execId))
  }

  private viewsOf(parentId: string): SubtaskView[] {
    return [...this.tasks.values()]
      .filter((t) => t.parentTaskId === parentId)
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        waitingOn: this.waits.get(t.id) ?? null,
        sourceDelegationId: t.sourceDelegationId,
        assigneeAgentId: t.assigneeAgentId,
        waitsOnThisTask: this.waitReaches(t.id, parentId),
        execs: this.ledger(t.id),
      }))
  }
  /** The real board's `waitReaches`: does this task need `to` to finish first? */
  private waitReaches(from: string, to: string): boolean {
    const seen = new Set<string>()
    const queue = [from]
    while (queue.length > 0) {
      const at = queue.pop()!
      if (at === to) return true
      if (seen.has(at)) continue
      seen.add(at)
      const row = this.tasks.get(at)
      if (!row || row.status === 'done' || row.status === 'cancelled') continue
      const wait = this.waits.get(at)
      if (wait?.kind === 'task') queue.push(wait.taskId)
      if (wait?.kind === 'subtasks')
        for (const t of this.tasks.values()) if (t.parentTaskId === at) queue.push(t.id)
      queue.push(...(this.depMap.get(at) ?? []))
    }
    return false
  }
  async subtasksOf(taskId: string): Promise<SubtaskView[] | null> {
    return this.viewsOf(taskId)
  }
  /** The real board's `releaseParentWaitTx`, in the same write as what caused it. */
  private releaseParent(parentId: string | null): void {
    const parent = parentId ? this.tasks.get(parentId) : undefined
    if (!parent || parent.status !== 'blocked') return
    const wait = this.waits.get(parent.id)
    const views = this.viewsOf(parent.id)
    const tally = tallySubtasks(views)
    if (wait?.kind === 'person' && wait.untilSubtasks) {
      if (!subtaskWaitOver(tally, { handedOutOnly: true }) || unfinishedSubtasks(tally) > 0) {
        if (unfinishedSubtasks(tally) > 0)
          this.waits.set(parent.id, { ...wait, need: unfinishedNeed(views) })
        return
      }
    } else {
      if (wait?.kind !== 'subtasks') return
      if (!subtaskWaitOver(tally, { handedOutOnly: wait.handedOut === true })) return
    }
    if (this.ledger(parent.id).some((r) => r.status === 'running')) return
    if (!delegationTargetOf(parent.sourceDelegationId)) {
      this.waits.set(parent.id, { kind: 'person', need: 'Decide what happens next.' })
      return
    }
    parent.status = 'todo'
    parent.assigneeAgentId = null
    this.waits.delete(parent.id)
    this.savedWakes.set(parent.id, [
      { id: `wake-${++this.wakeN}`, reason: 'subtasks_closed', commentIds: [] },
    ])
  }
  async releaseSubtaskWait(taskId: string): Promise<void> {
    this.releaseParent(taskId)
  }
  /** Tasks the task runner runs, for a scenario that needs one. */
  readonly runnerTasks = new Set<string>()
  async runsOnTaskRunner(taskId: string): Promise<boolean> {
    return this.runnerTasks.has(taskId)
  }

  /** What each task waits on, as `updateStatus` said. */
  readonly waits = new Map<string, WaitingOn>()
  async setWaitingOn(taskId: string, waitingOn: WaitingOn | null): Promise<void> {
    if (waitingOn) this.waits.set(taskId, waitingOn)
    else this.waits.delete(taskId)
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
      ...(t.createdAt !== undefined ? { createdAt: t.createdAt } : {}),
      ...(this.waits.has(t.id) ? { waitingOn: JSON.stringify(this.waits.get(t.id)) } : {}),
    }
  }

  async createTask(input: CreateTaskInput): Promise<BoardTask | null> {
    this.onCreate?.()
    const id = `task-${++this.taskN}`
    const row: FakeRow = {
      id,
      status: input.status ?? 'todo',
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

  // ── The engine's own surface, mirroring what the server binding does ──
  private keys = new Map<string, string>() // hand-off key → task id
  private failures = new Map<string, { failures: number; notified: boolean }>()

  private childCount(parentId: string): number {
    let n = 0
    for (const t of this.tasks.values()) if (t.parentTaskId === parentId) n += 1
    return n
  }
  private rootCount(): number {
    let n = 0
    for (const t of this.tasks.values()) if (t.parentTaskId === null) n += 1
    return n
  }
  private sameAsk(row: FakeRow, input: HandOffInput): boolean {
    const ask = (t: { title: string; description?: string | null }): string =>
      normalizeTaskTitle(
        t.title.length >= HAND_OFF_TITLE_CHARS && t.description?.startsWith(t.title)
          ? t.description
          : t.title,
      )
    return ask(row) === ask(input)
  }
  private openTitleMatch(input: HandOffInput): FakeRow | undefined {
    const parent = input.parentTaskId ?? null
    for (const t of this.tasks.values()) {
      if (t.parentTaskId !== parent || !this.sameAsk(t, input)) continue
      if (input.turnId && t.sourceDelegationId?.startsWith(`${input.turnId}:`)) continue
      if (
        !['todo', 'in_progress', 'in_review'].includes(t.status) &&
        !(t.status === 'blocked' && waitsOnOtherWork(this.waits.get(t.id)))
      )
        continue
      if (!t.assigneeAgentId && !delegationTargetOf(t.sourceDelegationId)) continue
      if (t.status === 'todo' && !ledgerWillAutoFire(this.ledger(t.id))) continue
      return t
    }
    return undefined
  }
  private ledger(taskId: string): Array<{ status: string; errorClass?: string | null }> {
    const out: Array<{ status: string; errorClass?: string | null }> = []
    for (const [execId, tid] of this.execs) {
      if (tid !== taskId) continue
      const done = this.completed.find((c) => c.execId === execId)
      out.push({
        status: done ? done.outcome.status : 'running',
        ...(done?.outcome.errorClass ? { errorClass: done.outcome.errorClass } : {}),
      })
    }
    return out
  }
  async createHandOff(input: HandOffInput): Promise<HandOffResult> {
    const key = input.handOffKey
      ? `${input.handOffKey.scope.join(':')}:${normalizeTaskTitle(input.handOffKey.text)}`
      : null
    const replayed = key ? this.tasks.get(this.keys.get(key) ?? '') : undefined
    if (replayed && replayed.status !== 'blocked') {
      return { ok: true, task: this.toBoardTask(replayed), deduplicated: 'key' }
    }
    const open = this.openTitleMatch(input)
    if (open) {
      if (key) this.keys.set(key, open.id)
      return { ok: true, task: this.toBoardTask(open), deduplicated: 'title' }
    }
    if (input.parentTaskId) {
      const count = this.childCount(input.parentTaskId)
      if (count >= DEFAULT_MAX_CHILDREN) {
        return { ok: false, reason: 'child_cap', count, max: DEFAULT_MAX_CHILDREN }
      }
    } else {
      const count = this.rootCount()
      if (count >= DEFAULT_MAX_ROOT_CREATES) {
        return {
          ok: false,
          reason: 'root_rate_cap',
          count,
          max: DEFAULT_MAX_ROOT_CREATES,
          windowMs: DEFAULT_ROOT_CREATE_WINDOW_MS,
        }
      }
    }
    const task = await this.createTask(input)
    if (!task) return { ok: false, reason: 'error' }
    if (key) this.keys.set(key, task.id)
    return { ok: true, task }
  }
  async handOffRoom(_teamId: string, parentTaskId: string | null): Promise<HandOffCapacity | null> {
    if (parentTaskId === null) {
      return {
        room: Math.max(0, DEFAULT_MAX_ROOT_CREATES - this.rootCount()),
        max: DEFAULT_MAX_ROOT_CREATES,
        reason: 'root_rate_cap',
      }
    }
    if (!this.tasks.has(parentTaskId)) return null
    return {
      room: Math.max(0, DEFAULT_MAX_CHILDREN - this.childCount(parentTaskId)),
      max: DEFAULT_MAX_CHILDREN,
      reason: 'child_cap',
    }
  }
  async handOffChain(taskId: string): Promise<HandOffLink[] | null> {
    const chain: HandOffLink[] = []
    let cursor: string | null = taskId
    while (cursor) {
      const row: FakeRow | undefined = this.tasks.get(cursor)
      if (!row) break
      chain.push({
        id: row.id,
        status: row.status,
        delegatedBy: delegatorOf(row.sourceDelegationId),
        title: row.title,
        identifier: null,
      })
      cursor = row.parentTaskId
    }
    return chain
  }
  private failureKey(teamId: string, target: string, task: string): string {
    return `${teamId}|${target}|${task}`
  }
  async delegationFailure(
    teamId: string,
    target: string,
    task: string,
  ): Promise<{ failures: number; notified: boolean }> {
    return (
      this.failures.get(this.failureKey(teamId, target, task)) ?? { failures: 0, notified: false }
    )
  }
  async noteDelegationFailure(teamId: string, target: string, task: string): Promise<void> {
    const k = this.failureKey(teamId, target, task)
    const now = this.failures.get(k) ?? { failures: 0, notified: false }
    this.failures.set(k, { ...now, failures: now.failures + 1 })
  }
  async markDelegationFailureNotified(teamId: string, target: string, task: string): Promise<void> {
    const k = this.failureKey(teamId, target, task)
    const now = this.failures.get(k)
    if (now) this.failures.set(k, { ...now, notified: true })
  }
  async clearDelegationFailure(teamId: string, target: string, task: string): Promise<void> {
    this.failures.delete(this.failureKey(teamId, target, task))
  }

  async claim(
    taskId: string,
    assigneeAgentId?: string,
    _assigneeRuntime?: string,
    run?: { runReason?: string | null },
  ): Promise<ClaimResult> {
    this.onClaim?.()
    this.claims.push(taskId)
    if (this.forceClaimConflict) return { ok: false, reason: 'conflict' }
    const t = this.tasks.get(taskId)
    if (!t || t.status !== 'todo' || t.assigneeAgentId) return { ok: false, reason: 'conflict' }
    t.status = 'in_progress'
    t.assigneeAgentId = assigneeAgentId ?? 'someone'
    this.waits.delete(taskId)
    const wakes = this.savedWakes.get(taskId)
    this.savedWakes.delete(taskId)
    // The real claim opens the run, for the wake it took, unless it is a provider retry.
    if (wakes?.length && run?.runReason !== 'provider_retry')
      this.claimReasons.set(
        taskId,
        wakes.map((w) => w.reason as string).reduce((a, b) => strongerWakeReason(a, b)),
      )
    return { ok: true, task: this.toBoardTask(t), ...(wakes ? { wakes } : {}) }
  }
  async updateStatus(
    taskId: string,
    status: string,
    opts?: { waitingOn?: WaitingOn },
  ): Promise<boolean> {
    const t = this.tasks.get(taskId)
    if (!t) return false
    if (!canTx(t.status, status)) return false // 409 — illegal transition
    this.statusUpdates.push({ taskId, status })
    if (opts?.waitingOn) this.waits.set(taskId, opts.waitingOn)
    else if (t.status !== status) this.waits.delete(taskId)
    t.status = status
    if (status === 'todo') t.assigneeAgentId = null // released → re-claimable
    if (['done', 'cancelled', 'blocked', 'backlog'].includes(status))
      this.releaseParent(t.parentTaskId)
    // The real board's wait on one task: its finishing sends the waiter back to the queue.
    if (status === 'done')
      for (const [id, w] of this.waits) {
        const waiter = this.tasks.get(id)
        if (w.kind !== 'task' || w.taskId !== taskId || waiter?.status !== 'blocked') continue
        waiter.status = 'todo'
        waiter.assigneeAgentId = null
        this.waits.delete(id)
      }
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
    return {
      task: this.toBoardTask(t),
      comments: this.commentRows.filter((c) => c.taskId === taskId),
      ancestors,
    }
  }
  async createExecution(
    taskId: string,
    _executorType?: string,
    opts?: { runReason?: string },
  ): Promise<ExecutionRef | null> {
    const id = `exec-${++this.execN}`
    this.execs.set(id, taskId)
    this.execReasons.set(id, this.claimReasons.get(taskId) ?? opts?.runReason ?? null)
    this.claimReasons.delete(taskId)
    this.execOpened.set(id, Date.now())
    return { id }
  }
  async completeExecution(execId: string, outcome: CompleteExecutionOutcome): Promise<void> {
    this.completed.push({ execId, outcome })
    if (!this.execClosed.has(execId)) this.execClosed.set(execId, Date.now())
  }
  async listExecutions(taskId: string): Promise<ExecutionSummary[] | null> {
    // Derive the ledger from the recorded calls: every exec opened for the task,
    // in id order; a completed one carries its outcome status, else 'running'.
    // Engine-created execs are 'openclaw' (fireTask/spawn) and marked as the engine's,
    // matching the real board: resume()'s ownership gate reads the marker.
    const rows: ExecutionSummary[] = []
    for (const [id, tid] of this.execs) {
      if (tid !== taskId) continue
      const done = this.completed.find((c) => c.execId === id)
      rows.push({
        id,
        status: done ? done.outcome.status : 'running',
        executorType: this.execTypes.get(id) ?? 'openclaw',
        engineRun: this.execMarks.has(id) ? this.execMarks.get(id) : 1,
        ...(done?.outcome.errorClass ? { errorClass: done.outcome.errorClass } : {}),
        ...(done?.outcome.error ? { error: done.outcome.error } : {}),
        runReason: this.execReasons.get(id) ?? null,
        ...(this.execOpened.has(id) ? { createdAt: this.execOpened.get(id)! } : {}),
        ...(this.execClosed.has(id) ? { completedAt: this.execClosed.get(id)! } : {}),
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
  async directDependents(taskId: string): Promise<string[]> {
    return [...this.depMap].filter(([, blockers]) => blockers.includes(taskId)).map(([id]) => id)
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
          this.releaseParent(t.parentTaskId)
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
      if (exec === 'running-executor') {
        this.execTypes.set(execId, 'codex')
        this.execMarks.set(execId, 0)
      }
      if (exec === 'running-reported-openclaw') this.execMarks.set(execId, 0)
      if (exec === 'running-old-openclaw') this.execMarks.set(execId, null)
    }
    return id
  }
  dispose(): void {
    // in-memory — nothing to release
  }
}
