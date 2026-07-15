// ─── Board repository (data-access layer) ───────────────────────────────────
// The ONLY place that reads/writes board tables. Keeps raw Drizzle out of the
// app (apps/web calls these) and is the single seam a future SQLite→Postgres /
// multi-tenant swap targets. Every read that could be tenant-scoped accepts an
// optional `scope` (dormant in v0.x — no filtering unless a tenantId is passed).

import { randomUUID } from 'node:crypto'

import { isVerdictPromotable } from '@clawboo/governance'
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import {
  executionProcesses,
  taskComments,
  taskDeps,
  tasks,
  workspaces,
  type DbExecutionProcess,
  type DbTask,
  type DbTaskComment,
  type DbWorkspace,
} from '../schema'
import { immediateWrite, withWriteRetry } from './contention'
import { ancestorRowsSchema, type AncestorRow } from './schemas'
import { canTransition, isTerminal, type TaskStatus } from './state-machine'

export interface Scope {
  tenantId?: string | null
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  title: string
  description?: string | null
  status?: TaskStatus // default 'todo' (ready to claim); 'backlog' for triage
  priority?: number
  teamId?: string | null
  assigneeRuntime?: string | null
  parentTaskId?: string | null
  sourceDelegationId?: string | null
  parentSessionId?: string | null
  tenantId?: string | null
  /** The one-TEAM-TASK-firing-owner label; the Routines engine passes 'clawboo'. */
  scheduledBy?: string
}

export function createTask(db: ClawbooDb, input: CreateTaskInput): DbTask {
  const now = Date.now()
  const row: DbTask = {
    id: randomUUID(),
    title: input.title,
    description: input.description ?? null,
    status: input.status ?? 'todo',
    priority: input.priority ?? 0,
    teamId: input.teamId ?? null,
    assigneeAgentId: null,
    assigneeRuntime: input.assigneeRuntime ?? null,
    parentTaskId: input.parentTaskId ?? null,
    sourceDelegationId: input.sourceDelegationId ?? null,
    worktreeRef: null,
    branchRef: null,
    costUsd: 0,
    parentSessionId: input.parentSessionId ?? null,
    dropped: 0,
    tenantId: input.tenantId ?? null,
    verification: null,
    scheduledBy: input.scheduledBy ?? 'manual',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  }
  withWriteRetry(() => db.insert(tasks).values(row).run())
  return row
}

/** A subtask is a task with `parentTaskId` set; it inherits the parent's team. */
export function createSubtask(
  db: ClawbooDb,
  parentTaskId: string,
  input: Omit<CreateTaskInput, 'parentTaskId'>,
): DbTask {
  const parent = getTask(db, parentTaskId)
  return createTask(db, {
    ...input,
    parentTaskId,
    teamId: input.teamId ?? parent?.teamId ?? null,
  })
}

export function getTask(db: ClawbooDb, taskId: string): DbTask | null {
  return (db.select().from(tasks).where(eq(tasks.id, taskId)).get() as DbTask | undefined) ?? null
}

export interface ListTasksFilter extends Scope {
  teamId?: string
  status?: TaskStatus
  includeDropped?: boolean
}

export function listTasks(db: ClawbooDb, filter: ListTasksFilter = {}): DbTask[] {
  const conds = []
  if (filter.teamId) conds.push(eq(tasks.teamId, filter.teamId))
  if (filter.status) conds.push(eq(tasks.status, filter.status))
  if (!filter.includeDropped) conds.push(eq(tasks.dropped, 0))
  if (filter.tenantId) conds.push(eq(tasks.tenantId, filter.tenantId))
  return db
    .select()
    .from(tasks)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(tasks.updatedAt))
    .all() as DbTask[]
}

// ─── Atomic claim (the mutex) ────────────────────────────────────────────────

export type ClaimReason = 'conflict' | 'not_found'
export interface ClaimResult {
  ok: boolean
  task?: DbTask
  reason?: ClaimReason
}

/**
 * Atomically claim a `todo` task for a single assignee. The guard
 * `status='todo' AND assignee IS NULL AND dropped=0` means at most one caller
 * wins; the loser gets `{ ok:false, reason:'conflict' }` and MUST NOT retry
 * (the "never retry a 409" rule). Transient lock errors ARE retried inside.
 *
 * Stale re-claim of a dead `in_progress` task is intentionally NOT handled here
 * — orphan reconciliation releases such a task back to `todo`, after which a
 * normal claim re-acquires it (liveness logic lives in one place).
 */
export function claimTask(
  db: ClawbooDb,
  taskId: string,
  assigneeAgentId: string,
  assigneeRuntime?: string | null,
): ClaimResult {
  const now = Date.now()
  return withWriteRetry(() => {
    const claimed = db
      .update(tasks)
      .set({
        assigneeAgentId,
        assigneeRuntime: assigneeRuntime ?? null,
        status: 'in_progress',
        updatedAt: now,
      })
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.status, 'todo'),
          isNull(tasks.assigneeAgentId),
          eq(tasks.dropped, 0),
        ),
      )
      .returning()
      .all() as DbTask[]

    if (claimed.length === 0) {
      const exists = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).get()
      return { ok: false, reason: exists ? 'conflict' : 'not_found' }
    }
    return { ok: true, task: claimed[0] }
  })
}

/** Release an `in_progress` task back to `todo` (clears the assignee). */
export function releaseTask(db: ClawbooDb, taskId: string): void {
  withWriteRetry(() =>
    db
      .update(tasks)
      // Releasing for re-claim is a cross-runtime rebind boundary: clear the stale
      // verification verdict too, so a prior runtime's failing verdict can't gate a
      // fresh runtime's legitimate `→done` (the within-runtime fix loop stays
      // `in_progress`, never released, so its attempt history is preserved).
      .set({
        assigneeAgentId: null,
        assigneeRuntime: null,
        verification: null,
        status: 'todo',
        updatedAt: Date.now(),
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, 'in_progress')))
      .run(),
  )
}

// ─── Status transitions (state-machine enforced) ─────────────────────────────

export type UpdateStatusReason = 'not_found' | 'illegal_transition' | 'verification_required'
export interface UpdateStatusResult {
  ok: boolean
  task?: DbTask
  reason?: UpdateStatusReason
}

/** Status-transition options. Default `{}` ⇒ the intrinsic verification gate
 *  applies; `humanOverride` is the explicit, audited escape hatch (the caller
 *  records the override). */
export interface UpdateStatusOptions {
  /** Bypass the intrinsic `→done` verification gate. The ONLY way a task with a
   *  non-promotable verdict can reach `done`; the caller MUST audit the override. */
  humanOverride?: boolean
}

/** Lightweight read of the persisted verification cell for the intrinsic `→done`
 *  gate. A full zod parse happens on WRITE (`setTaskVerification`); here a tiny
 *  inline JSON parse + the SHARED `isVerdictPromotable` rule avoids importing
 *  board/verification.ts (which would cycle with `getTask`). A NULL/absent cell
 *  means the task is unverified, not failing — return `true` (the gate only
 *  blocks when a non-promotable verdict EXISTS). An unparseable cell is treated
 *  leniently (cannot determine ⇒ don't block). */
function verdictCellPromotable(cell: string | null | undefined): boolean {
  if (!cell) return true
  try {
    return isVerdictPromotable(JSON.parse(cell))
  } catch {
    return true
  }
}

/**
 * Transition a task's status, enforcing the state machine against the freshly
 * read row inside a BEGIN IMMEDIATE txn (concurrency-safe). Sets `completedAt`
 * on terminal states. The verification gate is INTRINSIC: ANY transition to
 * `done` is rejected with `verification_required` when the task carries a
 * non-promotable verdict (a failing deterministic gate — incl. red-gate debt) —
 * the builder-≠-judge board rule, un-bypassable by any caller EXCEPT an explicit
 * `opts.humanOverride` (which the caller audits). A task with no stored verdict
 * is unverified, not failing, and lands `done` normally — the gate blocks
 * KNOWN-FAILING verdicts, NOT un-run verification; manually completing unverified
 * work is an intentional human judgment call (the autonomous path always writes a
 * verdict via verifyTask before this transition), not a gate bypass.
 */
export function updateStatus(
  db: ClawbooDb,
  taskId: string,
  to: TaskStatus,
  opts: UpdateStatusOptions = {},
): UpdateStatusResult {
  return immediateWrite(db, (tx) => {
    const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as DbTask | undefined
    if (!row) return { ok: false, reason: 'not_found' }
    const from = row.status as TaskStatus
    if (!canTransition(from, to)) return { ok: false, reason: 'illegal_transition' }
    if (to === 'done' && !opts.humanOverride && !verdictCellPromotable(row.verification)) {
      return { ok: false, reason: 'verification_required' }
    }
    const now = Date.now()
    tx.update(tasks)
      .set({
        status: to,
        updatedAt: now,
        ...(isTerminal(to) ? { completedAt: now } : {}),
        // A task moved back to `todo` is released for re-claim — clear the assignee
        // so the atomic claim (`assignee IS NULL`) can re-acquire it (matches
        // releaseTask / orphan reconciliation, which also unassign on release).
        // Without this, the in-browser orchestrator's "release to todo" would leave
        // a stale assignee and every re-fire would 409. Clear the verification verdict
        // too (the cross-runtime rebind boundary): a prior runtime's failing verdict
        // must not gate a fresh runtime's legitimate completion.
        ...(to === 'todo'
          ? { assigneeAgentId: null, assigneeRuntime: null, verification: null }
          : {}),
      })
      .where(eq(tasks.id, taskId))
      .run()
    const updated = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as DbTask
    return { ok: true, task: updated }
  })
}

/** Update non-status metadata (priority / title / description). Status changes
 *  must go through `updateStatus` so the state machine is enforced. */
export interface TaskFields {
  priority?: number
  title?: string
  description?: string | null
  /** The run's cost (USD). The engine creates a task at cost 0; the orchestrator writes
   *  the real/estimated run cost here so the board card + drawer show it. */
  costUsd?: number
  /** The agent's REAL runtime. The engine hardcodes `assigneeRuntime: 'openclaw'` at
   *  create; the orchestrator corrects it to the actual runtime for the card badge. */
  assigneeRuntime?: string | null
}

export function updateTaskFields(db: ClawbooDb, taskId: string, fields: TaskFields): DbTask | null {
  const patch: Partial<
    Pick<DbTask, 'priority' | 'title' | 'description' | 'costUsd' | 'assigneeRuntime'>
  > & { updatedAt: number } = {
    updatedAt: Date.now(),
  }
  if (fields.priority !== undefined) patch.priority = fields.priority
  if (fields.title !== undefined) patch.title = fields.title
  if (fields.description !== undefined) patch.description = fields.description
  if (fields.costUsd !== undefined) patch.costUsd = fields.costUsd
  if (fields.assigneeRuntime !== undefined) patch.assigneeRuntime = fields.assigneeRuntime
  withWriteRetry(() => db.update(tasks).set(patch).where(eq(tasks.id, taskId)).run())
  return getTask(db, taskId)
}

export function blockTask(db: ClawbooDb, taskId: string): UpdateStatusResult {
  return updateStatus(db, taskId, 'blocked')
}

export function unblockTask(db: ClawbooDb, taskId: string): UpdateStatusResult {
  return updateStatus(db, taskId, 'todo')
}

/** Soft-delete (auditable / restorable) — never destructive. */
export function dropTask(db: ClawbooDb, taskId: string): void {
  withWriteRetry(() =>
    db.update(tasks).set({ dropped: 1, updatedAt: Date.now() }).where(eq(tasks.id, taskId)).run(),
  )
}

// ─── Dependencies (Beads-style blocks / blocked-by) ──────────────────────────

export function linkDep(db: ClawbooDb, taskId: string, dependsOnTaskId: string): void {
  withWriteRetry(() =>
    db
      .insert(taskDeps)
      .values({ taskId, dependsOnTaskId, tenantId: null })
      .onConflictDoNothing()
      .run(),
  )
}

/**
 * The transitive set of tasks that depend on `taskId` (its downstream chain),
 * via the `task_deps` graph. Recursive CTE → zod-free raw read returned as rows
 * (the caller filters by status). Used to recover a stalled plan chain when a
 * blocker fails — a `blocked`/failed dependency would otherwise leave every
 * downstream step permanently un-ready (`getReadyTasks` requires deps `done`).
 */
export function getDependents(db: ClawbooDb, taskId: string): DbTask[] {
  return db.all(
    sql`
      WITH RECURSIVE dependents(id) AS (
        SELECT task_id FROM task_deps WHERE depends_on_task_id = ${taskId}
        UNION
        SELECT td.task_id FROM task_deps td JOIN dependents dep ON td.depends_on_task_id = dep.id
      )
      SELECT * FROM tasks WHERE id IN (SELECT id FROM dependents)
    `,
  ) as DbTask[]
}

/**
 * Cancel the still-pending (`todo`/`backlog`) transitive dependents of a failed
 * task — they can never become ready once their blocker is `blocked`/failed, so
 * cancelling them surfaces the dead chain instead of leaving ghost `todo` cards.
 * Returns the cancelled rows so the caller can report the stall to the leader.
 * Tasks already `in_progress`/`done`/`cancelled` are left untouched.
 */
export function cancelDependents(db: ClawbooDb, taskId: string): DbTask[] {
  const cancelled: DbTask[] = []
  for (const dep of getDependents(db, taskId)) {
    if (dep.status !== 'todo' && dep.status !== 'backlog') continue
    const r = updateStatus(db, dep.id, 'cancelled')
    if (r.ok && r.task) cancelled.push(r.task)
  }
  return cancelled
}

/** Tasks ready to work: `todo`, not dropped, with every dependency `done`. */
export function getReadyTasks(db: ClawbooDb, filter: { teamId?: string } & Scope = {}): DbTask[] {
  const conds = [
    eq(tasks.status, 'todo'),
    eq(tasks.dropped, 0),
    sql`NOT EXISTS (SELECT 1 FROM task_deps d JOIN tasks dt ON dt.id = d.depends_on_task_id WHERE d.task_id = ${tasks.id} AND dt.status != 'done')`,
  ]
  if (filter.teamId) conds.push(eq(tasks.teamId, filter.teamId))
  if (filter.tenantId) conds.push(eq(tasks.tenantId, filter.tenantId))
  return db
    .select()
    .from(tasks)
    .where(and(...conds))
    .orderBy(desc(tasks.priority), desc(tasks.updatedAt))
    .all() as DbTask[]
}

/**
 * Walk the parent chain via recursive CTE. Raw SQL → the result is validated
 * with zod (clawboo rule: never trust TS generics over raw-SQL output).
 */
export function getAncestors(db: ClawbooDb, taskId: string): AncestorRow[] {
  const rows = db.all(
    sql`
      WITH RECURSIVE ancestors(id) AS (
        SELECT parent_task_id FROM tasks WHERE id = ${taskId} AND parent_task_id IS NOT NULL
        UNION ALL
        SELECT t.parent_task_id FROM tasks t JOIN ancestors a ON t.id = a.id WHERE t.parent_task_id IS NOT NULL
      )
      SELECT id, parent_task_id, title, status FROM tasks WHERE id IN (SELECT id FROM ancestors)
    `,
  )
  return ancestorRowsSchema.parse(rows)
}

// ─── Comments ────────────────────────────────────────────────────────────────

export function addComment(
  db: ClawbooDb,
  taskId: string,
  body: string,
  authorType: 'agent' | 'user' | 'system',
  authorAgentId?: string | null,
): DbTaskComment {
  const now = Date.now()
  const row: DbTaskComment = {
    id: randomUUID(),
    taskId,
    authorAgentId: authorAgentId ?? null,
    authorType,
    body,
    tenantId: null,
    createdAt: now,
  }
  withWriteRetry(() => db.insert(taskComments).values(row).run())
  return row
}

export function getComments(db: ClawbooDb, taskId: string): DbTaskComment[] {
  return db
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .orderBy(taskComments.createdAt)
    .all() as DbTaskComment[]
}

// ─── Workspaces ──────────────────────────────────────────────────────────────

export function createWorkspace(
  db: ClawbooDb,
  taskId: string,
  repoPath: string,
  opts: { branch?: string | null; worktreePath?: string | null } = {},
): DbWorkspace {
  const now = Date.now()
  const row: DbWorkspace = {
    id: randomUUID(),
    taskId,
    repoPath,
    branch: opts.branch ?? null,
    worktreePath: opts.worktreePath ?? null,
    status: 'active',
    tenantId: null,
    createdAt: now,
    lastUsedAt: now,
  }
  withWriteRetry(() => db.insert(workspaces).values(row).run())
  return row
}

/** The most-recent workspace row for a task (status checked by the caller). */
export function getWorkspaceForTask(db: ClawbooDb, taskId: string): DbWorkspace | null {
  return (
    (db
      .select()
      .from(workspaces)
      .where(eq(workspaces.taskId, taskId))
      .orderBy(desc(workspaces.createdAt))
      .get() as DbWorkspace | undefined) ?? null
  )
}

export type WorkspaceStatus = 'active' | 'archived' | 'stale'

/** Update a workspace's lifecycle status (active → archived on cleanup, → stale on GC). */
export function updateWorkspaceStatus(
  db: ClawbooDb,
  workspaceId: string,
  status: WorkspaceStatus,
  opts: { lastUsedAt?: number } = {},
): void {
  withWriteRetry(() =>
    db
      .update(workspaces)
      .set({ status, ...(opts.lastUsedAt !== undefined ? { lastUsedAt: opts.lastUsedAt } : {}) })
      .where(eq(workspaces.id, workspaceId))
      .run(),
  )
}

/** All `active` workspaces — the GC sweep's candidate set. */
export function listActiveWorkspaces(db: ClawbooDb, filter: Scope = {}): DbWorkspace[] {
  const conds = [eq(workspaces.status, 'active')]
  if (filter.tenantId) conds.push(eq(workspaces.tenantId, filter.tenantId))
  return db
    .select()
    .from(workspaces)
    .where(and(...conds))
    .all() as DbWorkspace[]
}

/**
 * Record a task's worktree + branch refs (the board's pointer into the
 * filesystem system-of-record). Gateway still owns agent/session state — this
 * only annotates the durable task with where its isolated work lives.
 */
export function setTaskWorkspaceRefs(
  db: ClawbooDb,
  taskId: string,
  refs: { worktreeRef?: string | null; branchRef?: string | null },
): DbTask | null {
  const patch: { updatedAt: number; worktreeRef?: string | null; branchRef?: string | null } = {
    updatedAt: Date.now(),
  }
  if (refs.worktreeRef !== undefined) patch.worktreeRef = refs.worktreeRef
  if (refs.branchRef !== undefined) patch.branchRef = refs.branchRef
  withWriteRetry(() => db.update(tasks).set(patch).where(eq(tasks.id, taskId)).run())
  return getTask(db, taskId)
}

// ─── Execution processes ─────────────────────────────────────────────────────
// One spawned run for a task. Per the brief, an exec row is created only AFTER a
// successful claim. Wiring claim→exec to a live runtime is the runtime-executor
// layer's job; the primitives exist here for tests + the orphan-reconciliation guarantee.

export interface CreateExecInput {
  taskId: string
  executorType: string
  workspaceId?: string | null
  runReason?: string | null
  beforeCommit?: string | null
}

export function createExecutionProcess(db: ClawbooDb, input: CreateExecInput): DbExecutionProcess {
  const now = Date.now()
  const row: DbExecutionProcess = {
    id: randomUUID(),
    taskId: input.taskId,
    workspaceId: input.workspaceId ?? null,
    executorType: input.executorType,
    status: 'running',
    claimedAt: now,
    startedAt: now,
    completedAt: null,
    beforeCommit: input.beforeCommit ?? null,
    afterCommit: null,
    inputTokens: null,
    outputTokens: null,
    cacheRead: null,
    cacheWrite: null,
    costUsd: null,
    summary: null,
    runReason: input.runReason ?? null,
    error: null,
    recoveryTombstone: 0,
    tenantId: null,
    createdAt: now,
  }
  withWriteRetry(() => db.insert(executionProcesses).values(row).run())
  return row
}

export interface CompleteExecOutcome {
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled'
  summary?: string | null
  error?: string | null
  afterCommit?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  cacheRead?: number | null
  cacheWrite?: number | null
  costUsd?: number | null
}

export function completeExecutionProcess(
  db: ClawbooDb,
  execId: string,
  outcome: CompleteExecOutcome,
): void {
  const now = Date.now()
  withWriteRetry(() =>
    db
      .update(executionProcesses)
      .set({
        status: outcome.status,
        completedAt: now,
        summary: outcome.summary ?? null,
        error: outcome.error ?? null,
        afterCommit: outcome.afterCommit ?? null,
        inputTokens: outcome.inputTokens ?? null,
        outputTokens: outcome.outputTokens ?? null,
        cacheRead: outcome.cacheRead ?? null,
        cacheWrite: outcome.cacheWrite ?? null,
        costUsd: outcome.costUsd ?? null,
      })
      .where(eq(executionProcesses.id, execId))
      .run(),
  )
}

/** List a task's execution-process rows (the run ledger), oldest first. */
export function listExecutions(db: ClawbooDb, taskId: string): DbExecutionProcess[] {
  return db
    .select()
    .from(executionProcesses)
    .where(eq(executionProcesses.taskId, taskId))
    .orderBy(executionProcesses.createdAt)
    .all() as DbExecutionProcess[]
}

// ─── Orphan reconciliation (startup recovery) ────────────────────────────────

export interface ReconcileResult {
  reconciled: number
}

/**
 * On startup, any exec left `running` was orphaned when its process died with
 * the previous server. Mark each `failed` + set `recovery_tombstone=1` (so a
 * second pass is a no-op — no infinite auto-resume) and release its task back to
 * `todo`. Runs in one BEGIN IMMEDIATE txn.
 */
export function reconcileOrphans(db: ClawbooDb): ReconcileResult {
  return immediateWrite(db, (tx) => {
    const orphans = tx
      .select()
      .from(executionProcesses)
      .where(
        and(eq(executionProcesses.status, 'running'), eq(executionProcesses.recoveryTombstone, 0)),
      )
      .all() as DbExecutionProcess[]
    const now = Date.now()
    for (const ex of orphans) {
      tx.update(executionProcesses)
        .set({
          status: 'failed',
          completedAt: now,
          error: 'orphaned: process not alive on restart',
          recoveryTombstone: 1,
        })
        .where(eq(executionProcesses.id, ex.id))
        .run()
      tx.update(tasks)
        .set({
          assigneeAgentId: null,
          assigneeRuntime: null,
          verification: null,
          status: 'todo',
          updatedAt: now,
        })
        .where(and(eq(tasks.id, ex.taskId), inArray(tasks.status, ['in_progress', 'in_review'])))
        .run()
    }
    return { reconciled: orphans.length }
  })
}

/**
 * Periodic backstop for an `in_progress` task whose driving client view closed
 * (the in-browser idle watchdog only runs while the team chat is mounted). Any
 * task `in_progress` whose `updatedAt` is older than `olderThanMs` AND whose
 * execution is still `running` is timed-out + released to `todo`, so a hung
 * delegate doesn't sit forever when nobody is watching. The TTL is deliberately
 * GENEROUS (much longer than the client's 8-min watchdog) because `tasks.updatedAt`
 * is only bumped on status/claim writes, not on every agent event — a long-but-
 * active run must not be falsely swept. Idempotent (a swept task is no longer
 * `in_progress`). Mirrors `reconcileOrphans` but on a TTL, not at boot.
 */
export function reconcileStaleInProgress(db: ClawbooDb, olderThanMs: number): ReconcileResult {
  return immediateWrite(db, (tx) => {
    const cutoff = Date.now() - olderThanMs
    const stale = tx
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.status, 'in_progress'), eq(tasks.dropped, 0), lt(tasks.updatedAt, cutoff)),
      )
      .all() as DbTask[]
    const now = Date.now()
    let reconciled = 0
    for (const t of stale) {
      tx.update(executionProcesses)
        .set({
          status: 'timed_out',
          completedAt: now,
          error: 'stale: no progress within the watchdog window',
        })
        .where(and(eq(executionProcesses.taskId, t.id), eq(executionProcesses.status, 'running')))
        .run()
      tx.update(tasks)
        .set({
          assigneeAgentId: null,
          assigneeRuntime: null,
          verification: null,
          status: 'todo',
          updatedAt: now,
        })
        .where(eq(tasks.id, t.id))
        .run()
      reconciled += 1
    }
    return { reconciled }
  })
}
