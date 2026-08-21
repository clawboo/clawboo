// ─── Board repository (data-access layer) ───────────────────────────────────
// The ONLY place that reads/writes board tables. Keeps raw Drizzle out of the
// app (apps/web calls these) and is the single seam a future SQLite→Postgres /
// multi-tenant swap targets. Every read that could be tenant-scoped accepts an
// optional `scope` (dormant in v0.x — no filtering unless a tenantId is passed).

import { randomUUID } from 'node:crypto'

import { canTransition, isTerminal, type TaskStatus } from '@clawboo/board-core'
import {
  checkDepthCap,
  checkFanoutCap,
  DEFAULT_MAX_CHILDREN,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_ROOT_CREATES,
  DEFAULT_ROOT_CREATE_WINDOW_MS,
  isVerdictPromotable,
} from '@clawboo/governance'
import { and, count, desc, eq, gt, inArray, isNull, like, lt, sql } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { emitBoardLifecycle, type BoardLifecycleEvent } from './events'
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

/**
 * The row a create builds. Shared by `createTask` (plain write) and
 * `createCappedSubtask` (in-transaction write) so a new column can never be added
 * to one create path and missed by the other.
 */
function buildTaskRow(input: CreateTaskInput): DbTask {
  const now = Date.now()
  return {
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
}

export function createTask(db: ClawbooDb, input: CreateTaskInput): DbTask {
  const row = buildTaskRow(input)
  withWriteRetry(() => db.insert(tasks).values(row).run())
  emitBoardLifecycle({
    kind: 'task_created',
    taskId: row.id,
    teamId: row.teamId ?? null,
    status: row.status,
    sourceDelegationId: row.sourceDelegationId ?? null,
  })
  return row
}

/** A subtask is a task with `parentTaskId` set; it inherits the parent's team.
 *  The UNCAPPED primitive — the in-process orchestrator, the REST board, and the
 *  evals harness create parented tasks through their own already-bounded paths.
 *  The Tasks MCP boundary uses `createCappedSubtask` below instead. */
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

// ─── Guarded creation (the Tasks MCP boundary's create path) ─────────────────

// Re-exported so a caller (the Tasks MCP, its tests, the docs) can name the
// shipped defaults of the guarded creates without taking a governance dep.
export {
  DEFAULT_MAX_CHILDREN,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_ROOT_CREATES,
  DEFAULT_ROOT_CREATE_WINDOW_MS,
} from '@clawboo/governance'

export type CreateGuardReason = 'parent_not_found' | 'child_cap' | 'depth_cap' | 'root_rate_cap'

export interface SubtaskCaps {
  /** Max LIVE (non-dropped) children one parent may have. Default DEFAULT_MAX_CHILDREN. */
  maxChildren?: number
  /** Max ancestor depth the new child's PARENT may sit at. Default DEFAULT_MAX_DEPTH. */
  maxDepth?: number
}

export interface RootCreateCaps {
  /** Max LIVE root tasks created inside the window. Default DEFAULT_MAX_ROOT_CREATES. */
  maxRootCreates?: number
  /** The rolling window the count is measured over. Default DEFAULT_ROOT_CREATE_WINDOW_MS. */
  windowMs?: number
}

/**
 * A discriminated union, not `{ ok: boolean; task?: DbTask }` — so `ok: true`
 * GUARANTEES `task` and `ok: false` guarantees `reason`, and no caller needs a
 * non-null assertion. (`ClaimResult` / `UpdateStatusResult` predate this and keep
 * the looser shape; new refusal types should follow this one.)
 */
export type GuardedCreateResult =
  | { ok: true; task: DbTask }
  | {
      ok: false
      reason: CreateGuardReason
      /** Rows already counted — set on `child_cap` and `root_rate_cap` (exact). */
      count?: number
      /** The ceiling the denial was measured against — set on every cap denial. */
      max?: number
      /** The rolling window in ms — set on `root_rate_cap` only. */
      windowMs?: number
    }

/**
 * Create a subtask with the per-parent child-count + nesting-depth caps ENFORCED,
 * inside ONE `BEGIN IMMEDIATE` transaction. The Tasks MCP ships as a stdio bin —
 * one OS process per attached runtime, all on the shared DB file — so a
 * count-then-insert window would let two agents both land the N+1th child.
 *
 * Returns a result object and never throws for a policy denial (mirrors
 * `claimTask` / `updateStatus`). Deliberate: the MCP `buildServer` does not wrap
 * tool handlers in try/catch, so a throw here would reach the model as a JSON-RPC
 * protocol error instead of a tool result — exactly the `parent_not_found` bug
 * this function fixes.
 */
export function createCappedSubtask(
  db: ClawbooDb,
  parentTaskId: string,
  input: Omit<CreateTaskInput, 'parentTaskId'>,
  caps: SubtaskCaps = {},
): GuardedCreateResult {
  const maxChildren = caps.maxChildren ?? DEFAULT_MAX_CHILDREN
  const maxDepth = caps.maxDepth ?? DEFAULT_MAX_DEPTH

  // The callback's return type is annotated because the result is now bound to a
  // local (for the post-commit emit below) rather than returned directly, so it no
  // longer inherits this function's return type as its contextual type — without
  // the annotation `ok` widens to `boolean` and the discriminated union breaks.
  const result = immediateWrite(db, (tx): GuardedCreateResult => {
    const parent = tx.select().from(tasks).where(eq(tasks.id, parentTaskId)).get() as
      DbTask | undefined
    // A missing parent would otherwise reach the insert and trip
    // `PRAGMA foreign_keys = ON` — an exception, not data. Refuse it as data.
    if (!parent) return { ok: false, reason: 'parent_not_found' }

    // Fan-out: count LIVE siblings only (`dropped = 0`). Soft-delete is the user's
    // ONLY recovery once a parent is at the cap, so it must actually free a slot.
    // Terminal (`done`/`cancelled`) children DO count: the cap bounds rows on the
    // board, so a create → complete → create loop cannot outgrow it.
    const siblingRow = tx
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.parentTaskId, parentTaskId), eq(tasks.dropped, 0)))
      .get() as { n: number } | undefined
    const siblingCount = siblingRow?.n ?? 0
    if (!checkFanoutCap({ siblingCount, max: maxChildren }).ok) {
      return { ok: false, reason: 'child_cap', count: siblingCount, max: maxChildren }
    }

    // Depth: walk the parent chain with a HARD step bound rather than reusing
    // `getAncestors` — that helper takes a ClawbooDb, not a tx, so it would read
    // OUTSIDE this transaction. Bounding the walk also keeps a corrupt
    // `parent_task_id` cycle from spinning while this write lock is held: at most
    // `maxDepth` primary-key lookups, no matter what the data says. The observed
    // depth is deliberately not reported — the walk clamps, so the number could
    // be a lie.
    let parentDepth = 0
    let cursor: string | null = parent.parentTaskId
    while (cursor !== null && parentDepth < maxDepth) {
      parentDepth += 1
      const row = tx
        .select({ parentTaskId: tasks.parentTaskId })
        .from(tasks)
        .where(eq(tasks.id, cursor))
        .get()
      cursor = row?.parentTaskId ?? null
    }
    // `depth >= max` ⇒ the new child would be `depth + 1`, one level too deep. The
    // same rule the team-chat delegation loop applies to a source task before it
    // spawns, so nothing an existing path already creates gets tighter.
    if (!checkDepthCap({ depth: parentDepth, max: maxDepth }).ok) {
      return { ok: false, reason: 'depth_cap', max: maxDepth }
    }

    const row = buildTaskRow({
      ...input,
      parentTaskId,
      teamId: input.teamId ?? parent.teamId ?? null, // inherit, like createSubtask
    })
    tx.insert(tasks).values(row).run()
    return { ok: true, task: row }
  })
  // Post-commit, exactly as `createTask` does. The guarded creates insert INSIDE
  // their own transaction rather than delegating to `createTask`, so they have to
  // emit for themselves — without this a task created through the Tasks MCP is
  // invisible to every lifecycle subscriber (the ready-pump wake among them).
  if (result.ok)
    emitBoardLifecycle({
      kind: 'task_created',
      taskId: result.task.id,
      teamId: result.task.teamId ?? null,
      status: result.task.status,
      sourceDelegationId: result.task.sourceDelegationId ?? null,
    })
  return result
}

/**
 * Create a ROOT task (no parent) with a rolling-window RATE cap enforced, in the
 * same one-transaction shape as `createCappedSubtask`.
 *
 * Why a rate cap and not a lifetime total: a per-parent ceiling has no subject on
 * a root create, and a lifetime cap on roots would permanently jam a long-lived
 * board. Counting only OPEN roots instead would be trivially evadable, because the
 * same agent holds `update_task_status` and could complete-then-create forever.
 * A window bounds creation VELOCITY, which is the actual runaway signature, and it
 * self-clears — so a false positive costs a few minutes, not a wedged board.
 *
 * The count is deliberately NOT filtered to MCP-created rows: rows the REST board
 * or the Routines engine created still count, so an agent cannot launder rows in
 * through another surface to raise its own ceiling. Dropped rows fall out, which is
 * the operator's way to free quota early.
 */
export function createCappedRootTask(
  db: ClawbooDb,
  input: Omit<CreateTaskInput, 'parentTaskId'>,
  caps: RootCreateCaps = {},
): GuardedCreateResult {
  const maxRootCreates = caps.maxRootCreates ?? DEFAULT_MAX_ROOT_CREATES
  const windowMs = caps.windowMs ?? DEFAULT_ROOT_CREATE_WINDOW_MS
  const since = Date.now() - windowMs

  const result = immediateWrite(db, (tx): GuardedCreateResult => {
    // `idx_tasks_parent` covers the NULL-parent group (SQLite indexes NULLs), so
    // this is a scan of recent roots rather than the whole table.
    const row = tx
      .select({ n: count() })
      .from(tasks)
      .where(and(isNull(tasks.parentTaskId), eq(tasks.dropped, 0), gt(tasks.createdAt, since)))
      .get() as { n: number } | undefined
    const recent = row?.n ?? 0
    if (!checkFanoutCap({ siblingCount: recent, max: maxRootCreates }).ok) {
      return { ok: false, reason: 'root_rate_cap', count: recent, max: maxRootCreates, windowMs }
    }

    const created = buildTaskRow({ ...input, parentTaskId: null })
    tx.insert(tasks).values(created).run()
    return { ok: true, task: created }
  })
  // Post-commit — see the note in `createCappedSubtask`.
  if (result.ok)
    emitBoardLifecycle({
      kind: 'task_created',
      taskId: result.task.id,
      teamId: result.task.teamId ?? null,
      status: result.task.status,
      sourceDelegationId: result.task.sourceDelegationId ?? null,
    })
  return result
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
    emitBoardLifecycle({
      kind: 'task_claimed',
      taskId,
      teamId: claimed[0]!.teamId ?? null,
      assigneeAgentId,
    })
    return { ok: true, task: claimed[0] }
  })
}

/** How often a drain loop beats a running task. A TIMER, not a throttle: the
 *  beat must not ride observed events, or a run that is working silently stops
 *  proving it is alive. The stale-sweep TTL must comfortably exceed this. */
export const TASK_HEARTBEAT_MS = 30_000

/** The scan-side mirror of the engine's `MAX_AUTO_FIRES` fire policy (the two
 *  MUST agree — @clawboo/team-orchestration cannot import this package's value
 *  because the engine package deliberately stays free of the db graph). */
const AUTO_FIRE_LEDGER_CAP = 3

/**
 * Scan-side mirror of the engine's ready-pump fire policy over an execution
 * ledger: fireable unless the last run was `cancelled` (user Stop — never
 * auto-refire) or the TRAILING run of consecutive non-succeeded rows reached
 * the cap (a permafailing task — stop feeding it; a success in between resets
 * the streak, so a task that failed twice long ago is not penalized forever).
 */
export function isLedgerAutoFireable(execs: Array<{ status: string }>): boolean {
  if (execs.length === 0) return true
  if (execs[execs.length - 1]!.status === 'running') return false // someone owns it
  if (execs[execs.length - 1]!.status === 'cancelled') return false
  let trailingFailures = 0
  for (let i = execs.length - 1; i >= 0; i--) {
    const s = execs[i]!.status
    if (s === 'succeeded' || s === 'cancelled') break
    trailingFailures += 1
  }
  return trailingFailures < AUTO_FIRE_LEDGER_CAP
}

/**
 * Teams that have at least one FIREABLE delegation: a READY (deps-satisfied,
 * `todo`, non-dropped) task whose sourceDelegationId carries the `:agent:`
 * target marker AND whose execution ledger permits an auto-fire. The server
 * dispatch pump scans this to know WHICH team orchestrators to (re)build and
 * pump. Precision matters twice over: without the ledger filter one
 * permanently-parked task would rebuild its team's orchestrator every tick
 * forever, and without the readiness filter a dep-blocked plan tail would do
 * the same. The engine's own policy remains the final arbiter of what runs.
 */
export function listTeamsWithFireableDelegations(db: ClawbooDb): string[] {
  const candidates = db
    .selectDistinct({ teamId: tasks.teamId })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'todo'),
        eq(tasks.dropped, 0),
        like(tasks.sourceDelegationId, '%:agent:%'),
      ),
    )
    .all() as Array<{ teamId: string | null }>
  const teams = new Set<string>()
  for (const c of candidates) {
    if (!c.teamId || teams.has(c.teamId)) continue
    // Readiness (deps satisfied) comes from the same query the engine's pump
    // uses, so the two views can't drift.
    const ready = getReadyTasks(db, { teamId: c.teamId }) as Array<{
      id: string
      sourceDelegationId?: string | null
    }>
    for (const t of ready) {
      if (!/:agent:/.test(t.sourceDelegationId ?? '')) continue
      if (!isLedgerAutoFireable(listExecutions(db, t.id))) continue
      teams.add(c.teamId)
      break
    }
  }
  return [...teams]
}

/**
 * Liveness heartbeat for a running task: bump `updatedAt` — the exact column
 * `reconcileStaleInProgress` keys on — so an actively-driven run is never swept
 * as stale, and the sweep TTL can be minutes instead of an hour. Guarded on
 * `in_progress` (a beat racing a release/completion no-ops, never resurrecting
 * freshness) and, when given, on the assignee — so a stale driver from a
 * PREVIOUS claim can't keep beating a task that was released and re-claimed by
 * someone else, masking the new run's death.
 */
export function heartbeatTask(
  db: ClawbooDb,
  taskId: string,
  opts?: { assigneeAgentId?: string },
): void {
  withWriteRetry(() =>
    db
      .update(tasks)
      .set({ updatedAt: Date.now() })
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.status, 'in_progress'),
          ...(opts?.assigneeAgentId ? [eq(tasks.assigneeAgentId, opts.assigneeAgentId)] : []),
        ),
      )
      .run(),
  )
}

/**
 * TIMER-DRIVEN beat for the whole ownership window of a run — claim to terminal.
 * Returns a stop function; ALWAYS call it (a `finally`) or the interval leaks.
 *
 * Timer-driven, not event-driven, on purpose: liveness must mean "the owning
 * process is alive", not "the runtime emitted something recently". An event-
 * ridden beat dies during every legitimately-silent stretch — a 5-minute build
 * inside one tool call, a 10-minute wait behind the home mutex, worktree
 * provisioning — and the minutes-scale sweep would execute healthy work (the
 * engine grants an open tool call 24 min and the drain idle guard grants 30 min;
 * the sweep must never be stricter than either). If this process dies, the
 * interval dies with it and the beats stop — exactly the signal the sweep reads.
 */
export function startTaskHeartbeat(
  db: ClawbooDb,
  taskId: string,
  opts?: { assigneeAgentId?: string },
): () => void {
  const beat = (): void => {
    try {
      heartbeatTask(db, taskId, opts)
    } catch {
      /* a missed beat must never break the owner */
    }
  }
  beat()
  const timer = setInterval(beat, TASK_HEARTBEAT_MS)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}

/** Release an `in_progress` task back to `todo` (clears the assignee). */
export function releaseTask(db: ClawbooDb, taskId: string): void {
  const released = withWriteRetry(() =>
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
      .returning({ teamId: tasks.teamId })
      .all(),
  ) as Array<{ teamId: string | null }>
  if (released.length > 0)
    emitBoardLifecycle({
      kind: 'task_released',
      taskId,
      teamId: released[0]!.teamId ?? null,
      via: 'release',
    })
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
  // Post-commit emission: the bus fires only after the BEGIN IMMEDIATE txn
  // returned, so a subscriber can never observe (or act on) an uncommitted
  // transition.
  const result = immediateWrite(db, (tx): UpdateStatusResult => {
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
  if (result.ok && result.task)
    emitBoardLifecycle({
      kind: 'status_changed',
      taskId,
      teamId: result.task.teamId ?? null,
      status: to,
    })
  return result
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

export class TaskDependencyCycleError extends Error {
  readonly code = 'task_dependency_cycle'

  constructor(taskId: string, dependsOnTaskId: string) {
    super(`linking ${taskId} to ${dependsOnTaskId} would create a dependency cycle`)
    this.name = 'TaskDependencyCycleError'
  }
}

export function linkDep(db: ClawbooDb, taskId: string, dependsOnTaskId: string): void {
  immediateWrite(db, (tx) => {
    if (taskId === dependsOnTaskId) {
      throw new TaskDependencyCycleError(taskId, dependsOnTaskId)
    }
    const reachable = tx.all(
      sql`
        WITH RECURSIVE dependencies(id) AS (
          SELECT depends_on_task_id FROM task_deps WHERE task_id = ${dependsOnTaskId}
          UNION
          SELECT td.depends_on_task_id
          FROM task_deps td
          JOIN dependencies dep ON td.task_id = dep.id
        )
        SELECT id FROM dependencies WHERE id = ${taskId} LIMIT 1
      `,
    ) as Array<{ id: string }>
    if (reachable.length > 0) {
      throw new TaskDependencyCycleError(taskId, dependsOnTaskId)
    }
    tx.insert(taskDeps)
      .values({ taskId, dependsOnTaskId, tenantId: null })
      .onConflictDoNothing()
      .run()
  })
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
 *
 * `UNION` (not `UNION ALL`) so the recursion TERMINATES on a `parent_task_id`
 * cycle. No code path can create one — the column is written only at INSERT with
 * a fresh UUID, so a parent is always an older committed row, and `TaskFields`
 * cannot patch it — but a corrupt or hand-edited DB must not be able to hang a
 * caller. On acyclic data the two are equivalent (the outer `id IN (…)` already
 * de-duplicates), and this matches the `UNION` in `linkDep` / `getDependents`.
 *
 * DO NOT change this back. Measured on a two-row `a → b → a` cycle: `UNION`
 * returns in ~0 ms; `UNION ALL` never returns (it is an unbounded spin, not a
 * fast error). That is also why there is no regression test here — the failure
 * mode is a hang, so a guard test would stall CI rather than fail it.
 */
export function getAncestors(db: ClawbooDb, taskId: string): AncestorRow[] {
  const rows = db.all(
    sql`
      WITH RECURSIVE ancestors(id) AS (
        SELECT parent_task_id FROM tasks WHERE id = ${taskId} AND parent_task_id IS NOT NULL
        UNION
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
  const t = db.select({ teamId: tasks.teamId }).from(tasks).where(eq(tasks.id, taskId)).get() as
    { teamId: string | null } | undefined
  emitBoardLifecycle({
    kind: 'comment_added',
    taskId,
    teamId: t?.teamId ?? null,
    authorType,
    authorAgentId: authorAgentId ?? null,
  })
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

/**
 * Close an execution row. Returns the updated row (null when `execId` matched
 * nothing) so a caller holding only an `execId` can recover its `taskId`. The
 * obs `execution_completed` emitters need it to stay correlated with the
 * `execution_started` they pair with. Mirrors `createExecutionProcess`, which
 * has always returned its row.
 */
export function completeExecutionProcess(
  db: ClawbooDb,
  execId: string,
  outcome: CompleteExecOutcome,
): DbExecutionProcess | null {
  const now = Date.now()
  const completedRows = withWriteRetry(() =>
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
      // A terminal ledger row is IMMUTABLE: only a still-`running` exec can be
      // completed. The ledger is the dispatch pump's fire-policy input, where
      // `cancelled` means "user Stop" — a late abort terminal overwriting an
      // already-swept (`timed_out`) row would reclassify infra death as user
      // intent and permanently park refireable work. First terminal wins, and a
      // loser closes nothing, so it returns null and its caller skips the
      // duplicate `execution_completed` it would otherwise append.
      .where(and(eq(executionProcesses.id, execId), eq(executionProcesses.status, 'running')))
      .returning()
      .all(),
  ) as DbExecutionProcess[]
  const row = completedRows[0]
  if (!row) return null
  const t = db
    .select({ teamId: tasks.teamId })
    .from(tasks)
    .where(eq(tasks.id, row.taskId))
    .get() as { teamId: string | null } | undefined
  emitBoardLifecycle({
    kind: 'execution_completed',
    taskId: row.taskId,
    teamId: t?.teamId ?? null,
    execId,
    status: outcome.status,
    executorType: row.executorType,
  })
  return row
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
 * On startup, reap `running` execs whose driver is provably gone. LIVENESS-AWARE:
 * a run is reaped only when its task's `updatedAt` has missed several heartbeats
 * ({@link TASK_HEARTBEAT_MS} beats from the drain loops keep it fresh). A
 * still-beating run belongs to a LIVE process — a second clawboo process on the
 * same state dir, or the previous server's drains during a fast dev-loop restart
 * — and blanket-failing it was exactly the split-brain that silently destroyed
 * in-flight cascades. A run whose process truly died stops beating and is reaped
 * here (when already stale at boot) or by the interval sweep within the TTL.
 * Reaped execs get `failed` + `recovery_tombstone=1` (idempotent — no infinite
 * auto-resume) and their task released to `todo`. One BEGIN IMMEDIATE txn.
 */
export function reconcileOrphans(db: ClawbooDb, opts?: { staleAfterMs?: number }): ReconcileResult {
  // Default: the same order of magnitude as the sweep TTL (6 missed beats).
  const staleAfterMs = opts?.staleAfterMs ?? 6 * TASK_HEARTBEAT_MS
  const releasedEvents: BoardLifecycleEvent[] = []
  const result = immediateWrite(db, (tx) => {
    const cutoff = Date.now() - staleAfterMs
    const candidates = tx
      .select()
      .from(executionProcesses)
      .where(
        and(eq(executionProcesses.status, 'running'), eq(executionProcesses.recoveryTombstone, 0)),
      )
      .all() as DbExecutionProcess[]
    const orphans = candidates.filter((ex) => {
      const t = tx.select().from(tasks).where(eq(tasks.id, ex.taskId)).get() as DbTask | undefined
      // No task row (integrity edge) ⇒ reap. Otherwise reap only when the beat
      // clock is stale — a fresh row means SOMETHING is still driving this run.
      return !t || t.updatedAt < cutoff
    })
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
      const released = tx
        .update(tasks)
        .set({
          assigneeAgentId: null,
          assigneeRuntime: null,
          verification: null,
          status: 'todo',
          updatedAt: now,
        })
        .where(and(eq(tasks.id, ex.taskId), inArray(tasks.status, ['in_progress', 'in_review'])))
        .returning({ teamId: tasks.teamId })
        .all() as Array<{ teamId: string | null }>
      // Publish only when the row actually changed — the guard can no-op (the
      // task already left in_progress/in_review) and a phantom release would
      // wake pumps for nothing.
      if (released.length > 0)
        releasedEvents.push({
          kind: 'task_released',
          taskId: ex.taskId,
          teamId: released[0]!.teamId ?? null,
          via: 'orphan-reap',
        })
    }
    return { reconciled: orphans.length }
  })
  // Post-commit: subscribers must never see an uncommitted release.
  for (const ev of releasedEvents) emitBoardLifecycle(ev)
  return result
}

/**
 * Periodic backstop that releases an `in_progress` task whose driving process
 * died or wedged. Beat-governed: every claiming drain `heartbeatTask`s the row
 * every {@link TASK_HEARTBEAT_MS} on a timer, so `updatedAt` older than the TTL
 * means several consecutive missed beats — dead, not slow — and the TTL can be
 * minutes. ONLY tasks with a `running` execution row are swept: the
 * drains beat exactly the tasks they drive, so a task with no running execution
 * has no beat producer and must not be subject to a beat deadline (a human
 * dragging a card to `in_progress`, or a claimed-but-not-yet-dispatched task —
 * the dispatch pump's concern, not this sweep's). Idempotent (a swept task is
 * no longer `in_progress`). Mirrors `reconcileOrphans` but on a TTL, not at boot.
 */
export function reconcileStaleInProgress(db: ClawbooDb, olderThanMs: number): ReconcileResult {
  const releasedEvents: BoardLifecycleEvent[] = []
  const result = immediateWrite(db, (tx) => {
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
      const running = tx
        .select({ id: executionProcesses.id })
        .from(executionProcesses)
        .where(and(eq(executionProcesses.taskId, t.id), eq(executionProcesses.status, 'running')))
        .all()
      if (running.length === 0) continue // no beat producer ⇒ not beat-governed
      tx.update(executionProcesses)
        .set({
          status: 'timed_out',
          completedAt: now,
          error: 'stale: no heartbeat within the watchdog window',
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
      releasedEvents.push({
        kind: 'task_released',
        taskId: t.id,
        teamId: t.teamId ?? null,
        via: 'sweep',
      })
      reconciled += 1
    }
    return { reconciled }
  })
  // Post-commit: subscribers must never see an uncommitted release.
  for (const ev of releasedEvents) emitBoardLifecycle(ev)
  return result
}
