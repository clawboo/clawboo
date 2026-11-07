// The in-memory reference board the engine's tests run against. It enforces the
// REAL transition rules (@clawboo/board-core, the same module @clawboo/db enforces
// inside its write transaction) and records every call, so a test can assert what
// the engine asked the board to do. Shared by the cascade contract run
// (boardOrchestration.test.ts) and the engine's own scenario tests.

import {
  canTransition,
  delegationTargetOf,
  delegatorOf,
  encodePlanHolder,
  HAND_OFF_TITLE_CHARS,
  isPlanHolder,
  isTaskStatus,
  ledgerWillAutoFire,
  normalizeTaskTitle,
  parseResultClaim,
  requestWaitsOn,
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
  MainTaskState,
  PlanProposal,
  ProposePlanInput,
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
  isMainTask?: boolean
  completedAt?: number
  chatSessionKey?: string | null
  requestedBy?: unknown
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

  /** Tasks holding what a check found (the real board's `verification`). */
  verdicts = new Set<string>()
  seedVerdict(taskId: string): void {
    this.verdicts.add(taskId)
  }
  hasVerdict(taskId: string): boolean {
    return this.verdicts.has(taskId)
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
      ...(t.isMainTask ? { isMainTask: 1 } : {}),
      ...(t.chatSessionKey ? { chatSessionKey: t.chatSessionKey } : {}),
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
      chatSessionKey: input.chatSessionKey ?? null,
      requestedBy: input.requestedBy ?? null,
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
    // Under a person's request, or about to be: every request has its own main task,
    // and the same work asked for under another one is still a repeat.
    const anyRequest =
      input.mainTask !== undefined || (parent !== null && this.tasks.get(parent)?.isMainTask)
    for (const t of this.tasks.values()) {
      if (t.isMainTask) continue
      const parentMatches = anyRequest
        ? t.parentTaskId === null || this.tasks.get(t.parentTaskId)?.isMainTask === true
        : t.parentTaskId === parent
      if (!parentMatches || !this.sameAsk(t, input)) continue
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
    const heldMain = input.mainTask ? this.tasks.get(this.keys.get(input.mainTask.key) ?? '') : null
    // A request that has closed takes no more work, at any depth under it.
    for (
      let at = this.tasks.get(input.parentTaskId ?? heldMain?.id ?? '');
      at && !open;
      at = at.parentTaskId ? this.tasks.get(at.parentTaskId) : undefined
    )
      if (at.isMainTask && (at.status === 'done' || at.status === 'cancelled'))
        return { ok: false, reason: 'main_closed' }
    if (!open && input.mainTask && !heldMain) {
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
      const main: FakeRow = {
        id: `task-${++this.taskN}`,
        status: 'in_progress',
        parentTaskId: null,
        title: input.mainTask.title,
        description: input.mainTask.description,
        sourceDelegationId: null,
        assigneeAgentId: input.mainTask.leadAgentId,
        isMainTask: true,
        chatSessionKey: input.mainTask.chatSessionKey ?? null,
        requestedBy: input.mainTask.requestedBy ?? undefined,
      }
      this.tasks.set(main.id, main)
      this.keys.set(input.mainTask.key, main.id)
      const { mainTask: _main, handOffKey: _key, turnId: _turn, ...fields } = input
      const child = await this.createTask({ ...fields, parentTaskId: main.id })
      if (!child) return { ok: false, reason: 'error' }
      if (key) this.keys.set(key, child.id)
      return { ok: true, task: child, mainTask: this.toBoardTask(main) }
    }
    if (!open && heldMain)
      return this.createHandOff({
        ...input,
        mainTask: undefined,
        parentTaskId: heldMain.id,
      } as HandOffInput)
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
  // ── A plan that waits for a person ──
  planApproval = false
  private planQuestions = new Map<
    string,
    {
      taskId: string
      agentId: string
      steps: ProposePlanInput['steps']
      parentTaskId: string | null
      holder: boolean
      parallel: boolean
      status: 'pending' | 'accepted' | 'declined' | 'closed'
    }
  >()
  private planN = 0
  private planCards = new Map<string, string>()
  setPlanApproval(on: boolean): void {
    this.planApproval = on
  }
  waitingPlans(): Array<{ questionId: string; taskId: string; steps: string[] }> {
    return [...this.planQuestions]
      .filter(([, q]) => q.status === 'pending')
      .map(([questionId, q]) => ({
        questionId,
        taskId: q.taskId,
        steps: q.steps.map((s) => s.title),
      }))
  }
  answerPlan(
    questionId: string,
    answer: { accepted: boolean; note?: string },
  ): { ok: boolean; created: number } {
    const q = this.planQuestions.get(questionId)
    if (!q || q.status !== 'pending') return { ok: false, created: 0 }
    q.status = answer.accepted ? 'accepted' : 'declined'
    this.waits.delete(q.taskId)
    const task = this.tasks.get(q.taskId)
    // A card that only held the plan closes with its answer. It never runs.
    if (task && q.holder) {
      task.status = answer.accepted ? 'done' : 'cancelled'
      task.completedAt = Date.now()
    }
    if (!answer.accepted) {
      if (task && q.holder) this.releaseParent(task.parentTaskId)
      return { ok: true, created: 0 }
    }
    let previous: string | null = null
    q.steps.forEach((step, i) => {
      const id = `task-${++this.taskN}`
      this.tasks.set(id, {
        id,
        status: 'todo',
        parentTaskId: q.parentTaskId,
        title: step.title,
        description: step.description ?? step.title,
        sourceDelegationId: `${questionId}:plan:${i}:agent:${step.agentId}:reflectTo:${q.agentId}`,
        assigneeAgentId: null,
      })
      if (previous && !q.parallel) this.depMap.set(id, [previous])
      previous = id
    })
    if (task && q.holder) this.releaseParent(task.parentTaskId)
    return { ok: true, created: q.steps.length }
  }
  async planApprovalOn(): Promise<boolean> {
    return this.planApproval
  }
  async proposePlan(input: ProposePlanInput): Promise<PlanProposal> {
    if (!this.planApproval) {
      await this.startingWithoutAsking(input)
      return { status: 'off' }
    }
    if (input.steps.some((s) => (s.description ?? s.title).length > 4_000))
      return { status: 'refused', reason: 'step_too_long' }
    const own = input.taskId ? this.tasks.get(input.taskId) : undefined
    const onOwnTask = !!own && own.assigneeAgentId === input.agentId && own.status === 'in_progress'
    const cardKey = `${input.agentId}|${input.turnId}`
    const held = [...this.planQuestions.values()].find(
      (q) => q.status === 'pending' && q.holder && q.agentId === input.agentId,
    )
    const byTurn = held ? undefined : this.planCards.get(cardKey)
    const homeId = onOwnTask ? own!.id : (held?.taskId ?? byTurn)
    const same = (a: ProposePlanInput['steps'], b: ProposePlanInput['steps']): boolean =>
      a.length === b.length &&
      a.every((s, i) => s.title === b[i]!.title && s.agentId === b[i]!.agentId)
    let replaced: { title: string } | undefined
    if (homeId) {
      const last = [...this.planQuestions.values()].filter((q) => q.taskId === homeId).at(-1)
      if (last && same(last.steps, input.steps)) {
        if (last.status === 'pending') return { status: 'waiting', taskId: homeId }
        if (last.status === 'accepted' || last.status === 'declined')
          return {
            status: last.status === 'accepted' ? 'already_accepted' : 'already_declined',
            taskId: homeId,
            ...(byTurn ? { replay: true } : {}),
          }
      }
      for (const q of this.planQuestions.values())
        if (q.taskId === homeId && q.status === 'pending') {
          q.status = 'closed'
          replaced = { title: this.tasks.get(homeId)?.title ?? '' }
        }
    }
    if (!onOwnTask) {
      // What this agent already had answered, from any earlier turn.
      const answered = [...this.planQuestions.values()]
        .filter(
          (q) =>
            q.holder &&
            q.agentId === input.agentId &&
            (q.status === 'accepted' || q.status === 'declined') &&
            same(q.steps, input.steps),
        )
        .at(-1)
      if (answered)
        return {
          status: answered.status === 'accepted' ? 'already_accepted' : 'already_declined',
          taskId: answered.taskId,
        }
    }
    let task = homeId ? this.tasks.get(homeId) : undefined
    // A person's message with no task yet: the card and its main task land together, and a
    // plan that takes the place of a waiting one stays where that one is.
    let parentTaskId = input.parentTaskId
    let mainTask: BoardTask | undefined
    if (input.mainTask && !parentTaskId && !onOwnTask) {
      if (task) parentTaskId = task.parentTaskId
      else {
        const held = this.tasks.get(this.keys.get(input.mainTask.key) ?? '')
        if (held) parentTaskId = held.id
        else {
          if (this.rootCount() >= DEFAULT_MAX_ROOT_CREATES)
            return { status: 'refused', reason: 'root_rate_cap' }
          const main: FakeRow = {
            id: `task-${++this.taskN}`,
            status: 'in_progress',
            parentTaskId: null,
            title: input.mainTask.title,
            description: input.mainTask.description,
            sourceDelegationId: null,
            assigneeAgentId: input.mainTask.leadAgentId,
            isMainTask: true,
            chatSessionKey: input.mainTask.chatSessionKey ?? null,
          }
          this.tasks.set(main.id, main)
          this.keys.set(input.mainTask.key, main.id)
          parentTaskId = main.id
          mainTask = this.toBoardTask(main)
        }
      }
    }
    if (!task) {
      const id = `task-${++this.taskN}`
      task = {
        id,
        status: 'blocked',
        parentTaskId,
        title: '',
        description: 'hold',
        sourceDelegationId: encodePlanHolder(input.agentId, id),
        assigneeAgentId: input.agentId,
        chatSessionKey: input.chatSessionKey ?? null,
      }
      this.tasks.set(id, task)
      this.planCards.set(cardKey, id)
    }
    if (!onOwnTask) task.title = `Plan: ${input.steps[0]!.title}`
    task.status = 'blocked'
    this.waits.set(task.id, { kind: 'question', questionId: `q-${this.planN + 1}` })
    this.planQuestions.set(`q-${++this.planN}`, {
      taskId: task.id,
      agentId: input.agentId,
      steps: input.steps,
      parentTaskId: onOwnTask ? own!.id : parentTaskId,
      holder: !onOwnTask,
      parallel: input.parallel === true,
      status: 'pending',
    })
    return {
      status: 'proposed',
      task: this.toBoardTask(task),
      holder: !onOwnTask,
      ...(replaced ? { replaced } : {}),
      ...(mainTask ? { mainTask } : {}),
    }
  }
  async startingWithoutAsking(input: { agentId: string }): Promise<void> {
    for (const q of this.planQuestions.values()) {
      if (q.status !== 'pending' || !q.holder || q.agentId !== input.agentId) continue
      q.status = 'closed'
      this.waits.delete(q.taskId)
      const task = this.tasks.get(q.taskId)
      if (task) {
        task.status = 'cancelled'
        task.completedAt = Date.now()
      }
    }
  }
  async closeWaitingPlans(): Promise<void> {
    for (const q of this.planQuestions.values()) {
      if (q.status !== 'pending') continue
      q.status = 'closed'
      const task = this.tasks.get(q.taskId)
      if (!task) continue
      this.waits.delete(task.id)
      task.status = q.holder ? 'cancelled' : 'todo'
      if (q.holder) {
        task.completedAt = Date.now()
        continue
      }
      task.assigneeAgentId = null
      const ref = await this.createExecution(task.id)
      if (ref) await this.completeExecution(ref.id, { status: 'cancelled', byPerson: true })
    }
  }

  async handOffRoom(
    _teamId: string,
    parentTaskId: string | null,
    opts?: { newRequest?: boolean },
  ): Promise<HandOffCapacity | null> {
    if (parentTaskId === null) {
      if (opts?.newRequest && this.rootCount() < DEFAULT_MAX_ROOT_CREATES)
        return { room: DEFAULT_MAX_CHILDREN, max: DEFAULT_MAX_CHILDREN, reason: 'child_cap' }
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
  private stateOf(row: FakeRow): MainTaskState {
    const below: FakeRow[] = []
    const walk = (id: string): void => {
      for (const t of this.tasks.values())
        if (t.parentTaskId === id) {
          below.push(t)
          walk(t.id)
        }
    }
    walk(row.id)
    const closed = (t: FakeRow): boolean => t.status === 'done' || t.status === 'cancelled'
    const times = below.flatMap((t) => (t.completedAt !== undefined ? [t.completedAt] : []))
    const viewOf = (t: FakeRow): SubtaskView => ({
      id: t.id,
      title: t.title,
      status: t.status,
      waitingOn: this.waits.get(t.id) ?? null,
      sourceDelegationId: t.sourceDelegationId,
      assigneeAgentId: t.assigneeAgentId,
      waitsOnThisTask: this.waitReaches(t.id, row.id),
      execs: this.ledger(t.id),
    })
    return {
      id: row.id,
      title: row.title,
      identifier: null,
      status: row.status,
      leadAgentId: row.assigneeAgentId,
      open: !closed(row),
      subtaskIds: below.map((t) => t.id),
      openSubtasks: below.filter((t) => requestWaitsOn(viewOf(t))).length,
      doneSubtasks: below.filter((t) => t.status === 'done' && !isPlanHolder(t.sourceDelegationId))
        .length,
      cancelledSubtasks: below.filter((t) => t.status === 'cancelled').length,
      lastClosedAt: times.length > 0 ? Math.max(...times) : null,
    }
  }
  async mainTaskState(taskId: string): Promise<MainTaskState | null> {
    const row = this.tasks.get(taskId)
    return row?.isMainTask ? this.stateOf(row) : null
  }
  async openMainTasks(): Promise<MainTaskState[]> {
    return [...this.tasks.values()]
      .filter((t) => t.isMainTask && t.status !== 'done' && t.status !== 'cancelled')
      .map((t) => this.stateOf(t))
  }
  async closeMainTask(taskId: string, to: 'done' | 'cancelled'): Promise<boolean> {
    const row = this.tasks.get(taskId)
    if (!row?.isMainTask || row.status === 'done' || row.status === 'cancelled') return false
    row.status = to
    row.completedAt = Date.now()
    this.statusUpdates.push({ taskId, status: to })
    return true
  }
  async parkMainTask(taskId: string, need: string): Promise<boolean> {
    const row = this.tasks.get(taskId)
    if (!row?.isMainTask || row.status === 'done' || row.status === 'cancelled') return false
    row.status = 'blocked'
    this.waits.set(taskId, { kind: 'person', need })
    this.statusUpdates.push({ taskId, status: 'blocked' })
    return true
  }
  async resumeMainTask(taskId: string): Promise<boolean> {
    const row = this.tasks.get(taskId)
    if (!row?.isMainTask || row.status !== 'blocked') return false
    row.status = 'in_progress'
    this.waits.delete(taskId)
    return true
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
    if (!t || t.status !== 'todo' || t.assigneeAgentId || t.isMainTask)
      return { ok: false, reason: 'conflict' }
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
    opts?: { waitingOn?: WaitingOn; keepVerdict?: boolean },
  ): Promise<boolean> {
    const t = this.tasks.get(taskId)
    if (!t) return false
    if (!canTx(t.status, status)) return false // 409 — illegal transition
    if (t.isMainTask && t.status !== status) return false
    if ((status === 'done' || status === 'cancelled') && t.status !== status)
      t.completedAt = Date.now()
    this.statusUpdates.push({ taskId, status })
    if (opts?.waitingOn) this.waits.set(taskId, opts.waitingOn)
    else if (t.status !== status) this.waits.delete(taskId)
    t.status = status
    if (status === 'todo') {
      t.assigneeAgentId = null // released → re-claimable
      if (!opts?.keepVerdict) this.verdicts.delete(taskId)
    }
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
  async addComment(
    taskId: string,
    body: string,
    authorType?: 'agent' | 'user' | 'system',
  ): Promise<void> {
    this.comments.push({ taskId, body })
    // A run's report, in the shape the real board stores it.
    if (authorType === 'agent')
      this.commentRows.push({ taskId, body, kind: 'result', createdAt: Date.now() })
  }
  async getTask(taskId: string): Promise<TaskDetail | null> {
    const t = this.tasks.get(taskId)
    if (!t) return null
    const ancestors: { id: string; isMainTask?: boolean }[] = []
    let cur = t.parentTaskId
    while (cur) {
      ancestors.push({ id: cur, ...(this.tasks.get(cur)?.isMainTask ? { isMainTask: true } : {}) })
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
      if (t.status !== 'todo' || t.isMainTask) continue
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
