// ─── Board repository (data-access layer) ───────────────────────────────────
// The ONLY place that reads/writes board tables. Keeps raw Drizzle out of the
// app (apps/web calls these) and is the single seam for any change of storage.
// Every read that could be tenant-scoped accepts an optional `scope` (no
// filtering unless a tenantId is passed).

import { randomUUID } from 'node:crypto'

import {
  canTransition,
  clampTaskPriority,
  delegationTargetOf,
  delegationFailureKey,
  delegatorOf,
  isTerminal,
  ledgerAllowsAutoFire,
  LOCAL_PERSON,
  parseWaitingOn,
  personMoveAllowed,
  strongerWakeReason,
  waitingOnJson,
  runMadeProgress,
  type CommentKind,
  type HandOffLink,
  type LedgerRun,
  type RunCostSource,
  type TaskStatus,
  type WaitingOn,
} from '@clawboo/board-core'
import {
  checkDepthCap,
  checkFanoutCap,
  DEFAULT_MAX_CHILDREN,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_ROOT_CREATES,
  DEFAULT_ROOT_CREATE_WINDOW_MS,
  isVerdictPromotable,
} from '@clawboo/governance'
import { and, count, desc, eq, gt, inArray, isNull, like, lt, or, sql } from 'drizzle-orm'

import { readyOrder } from './readyOrder'

import type { ClawbooDb } from '../db'
import { appendEvent } from '../events/appendEvent'
import { parsePersonJson, personJson, type PersonRecord } from '../person'
import {
  adoptTaskWakesTx,
  recordDependencyWakesTx,
  recordTaskWakeTx,
  settleWakesOfClosedRunTx,
} from '../taskWakes'
import { ORPHANED_RUN_ERROR, STALE_RUN_ERROR } from './attempts'
import { isTaskRunnerRun } from './runnerInputs'
import { emitBoardLifecycle, type BoardLifecycleEvent } from './events'
import { startRefusedBy, startRefusedByTask } from './pauses'
import {
  delegationFailures,
  executionProcesses,
  taskComments,
  taskCreateKeys,
  taskDeps,
  tasks,
  teams,
  workspaces,
  type DbExecutionProcess,
  type DbTask,
  type DbTaskComment,
  type DbTaskWake,
  type DbWorkspace,
} from '../schema'
import { immediateWrite, withWriteRetry, type BoardTx } from './contention'
import { expirePendingQuestionsTx } from './questionExpiry'
import {
  existingTaskForCreate,
  rememberCreateKey,
  type CreatedTask,
  type TaskCreateKey,
} from './createDedupe'
import { allocateTaskIdentifier } from './identifiers'
import { ancestorRowsSchema, type AncestorRow } from './schemas'

export { SAME_TASK_WINDOW_MS } from './createDedupe'
export type { CreatedTask, DedupedBy, TaskCreateKey } from './createDedupe'

export interface Scope {
  tenantId?: string | null
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  title: string
  description?: string | null
  status?: TaskStatus // default 'todo' (ready to claim); 'backlog' for triage
  /** Clamped to the four named levels (`clampTaskPriority`); default 0, normal. */
  priority?: number
  teamId?: string | null
  assigneeRuntime?: string | null
  parentTaskId?: string | null
  sourceDelegationId?: string | null
  parentSessionId?: string | null
  tenantId?: string | null
  /** The one-TEAM-TASK-firing-owner label; the Routines engine passes 'clawboo'. */
  scheduledBy?: string
  /** The chat room the task belongs to. Null/absent = the team's default room. A
   *  subtask inherits its parent's room when none is given. */
  roomId?: string | null
  /** What a task created Blocked or In review waits for. */
  waitingOn?: WaitingOn | null
  /** The person who asked for it: who a hand-back goes to. */
  requestedBy?: PersonRecord | null
  /** The person it is assigned to from the start. */
  assigneePerson?: PersonRecord | null
  /** Makes the create safe to repeat: the same key returns the same task. */
  createKey?: TaskCreateKey | null
  /** An agent is creating it, not a person: the same-title check applies. */
  agentCreated?: boolean
  /** The create has a target (a hand-off): only a task someone is on, and that will
   *  run, can stand in. */
  titleMatchNeedsOwner?: boolean
  /** Tasks from this turn do not stand in for it. */
  titleMatchExceptTurn?: string | null
  /** The agent handing it out through the Tasks tools (the cycle guard reads it). */
  delegatedByAgentId?: string | null
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
    // Every create path builds its row here, so this is the one clamp: no
    // writer, an agent's create_task included, can jump the queue with a
    // large number.
    priority: clampTaskPriority(input.priority ?? 0),
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
    roomId: input.roomId ?? null,
    personMovedAt: null,
    runnerInputs: null,
    waitingOn: waitingOnJson(input.waitingOn),
    assigneePersonId: input.assigneePerson?.id ?? null,
    assigneePerson: personJson(input.assigneePerson),
    requestedBy: personJson(input.requestedBy),
    identifier: null,
    delegatedByAgentId: input.delegatedByAgentId ?? null,
    personCancelledAt: null,
    checkHeldSince: null,
    runExecutionId: null,
  }
}

/** Write a new task inside the caller's transaction: its row, its readable id and
 *  its idempotency key, so all three land or none do. */
function insertTask(tx: BoardTx, input: CreateTaskInput): DbTask {
  const row = buildTaskRow(input)
  row.identifier = allocateTaskIdentifier(tx, row.teamId)
  tx.insert(tasks).values(row).run()
  if (input.createKey) rememberCreateKey(tx, input.createKey, row.id, row.createdAt)
  return row
}

export function createTask(db: ClawbooDb, input: CreateTaskInput): CreatedTask {
  const row = immediateWrite(
    db,
    (tx): CreatedTask => existingTaskForCreate(tx, input, Date.now()) ?? insertTask(tx, input),
  )
  if (!row.deduplicated)
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
): CreatedTask {
  const parent = getTask(db, parentTaskId)
  return createTask(db, {
    ...input,
    parentTaskId,
    teamId: input.teamId ?? parent?.teamId ?? null,
    roomId: input.roomId ?? parent?.roomId ?? null,
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
  /** Count only this team's roots, so one team's busy hour does not stop another
   *  team's lead handing out work. Omitted: every team's. */
  teamId?: string | null
}

/**
 * A discriminated union, not `{ ok: boolean; task?: DbTask }` — so `ok: true`
 * GUARANTEES `task` and `ok: false` guarantees `reason`, and no caller needs a
 * non-null assertion. (`ClaimResult` / `UpdateStatusResult` predate this and keep
 * the looser shape; new refusal types should follow this one.)
 */
export type GuardedCreateResult =
  | { ok: true; task: CreatedTask }
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
 * How many slots a parent's children hold. Dropped children free theirs (soft-delete
 * is an operator's recovery). Done and cancelled children keep theirs: the cap bounds
 * rows on the board, so a create → complete → create loop cannot outgrow it, and an
 * agent cannot cancel its own children and create more. Only a person's cancel frees
 * a slot (`personCancelledAt`).
 */
function countChildSlots(tx: ClawbooDb | BoardTx, parentTaskId: string): number {
  const row = tx
    .select({ n: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.parentTaskId, parentTaskId),
        eq(tasks.dropped, 0),
        isNull(tasks.personCancelledAt),
      ),
    )
    .get() as { n: number } | undefined
  return row?.n ?? 0
}

/** Live root tasks created since a moment. `idx_tasks_parent_dropped_created` serves
 *  it, so this is a scan of recent roots rather than the whole table. */
function countRecentRoots(tx: ClawbooDb | BoardTx, since: number, teamId?: string | null): number {
  const row = tx
    .select({ n: count() })
    .from(tasks)
    .where(
      and(
        isNull(tasks.parentTaskId),
        eq(tasks.dropped, 0),
        gt(tasks.createdAt, since),
        ...(teamId ? [eq(tasks.teamId, teamId)] : []),
      ),
    )
    .get() as { n: number } | undefined
  return row?.n ?? 0
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

    const resolved = {
      ...input,
      parentTaskId,
      teamId: input.teamId ?? parent.teamId ?? null, // inherit, like createSubtask
      roomId: input.roomId ?? parent.roomId ?? null,
    }
    // Before the caps: a repeat makes no row, so a cap has nothing to refuse, and a
    // retry must get the task it made rather than a refusal.
    const existing = existingTaskForCreate(tx, resolved, Date.now())
    if (existing) return { ok: true, task: existing }

    const siblingCount = countChildSlots(tx, parentTaskId)
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

    return { ok: true, task: insertTask(tx, resolved) }
  })
  // Post-commit, exactly as `createTask` does. The guarded creates insert INSIDE
  // their own transaction rather than delegating to `createTask`, so they have to
  // emit for themselves — without this a task created through the Tasks MCP is
  // invisible to every lifecycle subscriber (the ready-pump wake among them).
  if (result.ok && !result.task.deduplicated)
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
    const resolved = { ...input, parentTaskId: null }
    // Before the cap, as in `createCappedSubtask`.
    const existing = existingTaskForCreate(tx, resolved, Date.now())
    if (existing) return { ok: true, task: existing }

    const recent = countRecentRoots(tx, since, caps.teamId)
    if (!checkFanoutCap({ siblingCount: recent, max: maxRootCreates }).ok) {
      return { ok: false, reason: 'root_rate_cap', count: recent, max: maxRootCreates, windowMs }
    }

    return { ok: true, task: insertTask(tx, resolved) }
  })
  // Post-commit — see the note in `createCappedSubtask`.
  if (result.ok && !result.task.deduplicated)
    emitBoardLifecycle({
      kind: 'task_created',
      taskId: result.task.id,
      teamId: result.task.teamId ?? null,
      status: result.task.status,
      sourceDelegationId: result.task.sourceDelegationId ?? null,
    })
  return result
}

export interface HandOffCapacity {
  /** How many more tasks fit right now. */
  room: number
  max: number
  reason: 'child_cap' | 'root_rate_cap'
}

/**
 * How many tasks the capped creates would let in under this parent (null: at the
 * root), so a plan can be refused whole instead of stopping partway. Only an
 * estimate under a concurrent writer: each create still checks for itself. Null for
 * a parent that does not exist.
 */
export function handOffCapacity(
  db: ClawbooDb,
  parentTaskId: string | null,
  teamId?: string | null,
): HandOffCapacity | null {
  if (parentTaskId === null) {
    const recent = countRecentRoots(db, Date.now() - DEFAULT_ROOT_CREATE_WINDOW_MS, teamId)
    return {
      room: Math.max(0, DEFAULT_MAX_ROOT_CREATES - recent),
      max: DEFAULT_MAX_ROOT_CREATES,
      reason: 'root_rate_cap',
    }
  }
  if (!getTask(db, parentTaskId)) return null
  return {
    room: Math.max(0, DEFAULT_MAX_CHILDREN - countChildSlots(db, parentTaskId)),
    max: DEFAULT_MAX_CHILDREN,
    reason: 'child_cap',
  }
}

/** The most levels `handOffChain` walks. Well past the depth caps; it bounds the
 *  walk over a corrupt `parent_task_id` cycle. */
const MAX_CHAIN_LINKS = 32

/**
 * A task and its ancestors, nearest first, each with the agent that handed it out:
 * what the hand-off cycle guard reads. The engine records its delegator in
 * `source_delegation_id`, and the Tasks tools in `delegated_by_agent_id`.
 */
export function handOffChain(db: ClawbooDb, taskId: string): HandOffLink[] {
  const chain: HandOffLink[] = []
  let cursor: string | null = taskId
  while (cursor !== null && chain.length < MAX_CHAIN_LINKS) {
    const row: DbTask | undefined = db.select().from(tasks).where(eq(tasks.id, cursor)).get() as
      DbTask | undefined
    if (!row) break
    chain.push({
      id: row.id,
      status: row.status,
      delegatedBy: row.delegatedByAgentId ?? delegatorOf(row.sourceDelegationId),
      title: row.title,
      identifier: row.identifier,
    })
    cursor = row.parentTaskId
  }
  return chain
}

/** Record who handed a task out through the Tasks tools. */
export function setTaskDelegator(db: ClawbooDb, taskId: string, agentId: string): void {
  withWriteRetry(() =>
    db.update(tasks).set({ delegatedByAgentId: agentId }).where(eq(tasks.id, taskId)).run(),
  )
}

/** Is this agent the team's own lead? A host that knows more leads (Boo Zero leads
 *  every team) adds them. */
export function isTeamLeadAgent(db: ClawbooDb, teamId: string | null, agentId: string): boolean {
  if (!teamId) return false
  const team = db
    .select({ leaderAgentId: teams.leaderAgentId })
    .from(teams)
    .where(eq(teams.id, teamId))
    .get()
  return team?.leaderAgentId === agentId
}

export function getTask(db: ClawbooDb, taskId: string): DbTask | null {
  return (db.select().from(tasks).where(eq(tasks.id, taskId)).get() as DbTask | undefined) ?? null
}

/**
 * A room filter. `undefined` = every room; `null` = the team's default room only
 * (the tasks with no room); a string = that room only.
 */
export type RoomFilter = string | null | undefined

function roomCondition(roomId: RoomFilter) {
  if (roomId === undefined) return null
  return roomId === null ? isNull(tasks.roomId) : eq(tasks.roomId, roomId)
}

export interface ListTasksFilter extends Scope {
  teamId?: string
  status?: TaskStatus
  includeDropped?: boolean
  roomId?: RoomFilter
}

export function listTasks(db: ClawbooDb, filter: ListTasksFilter = {}): DbTask[] {
  const conds = []
  if (filter.teamId) conds.push(eq(tasks.teamId, filter.teamId))
  const room = roomCondition(filter.roomId)
  if (room) conds.push(room)
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

export type ClaimReason = 'conflict' | 'not_found' | 'paused' | 'person_assigned'
export interface ClaimResult {
  ok: boolean
  task?: DbTask
  reason?: ClaimReason
  /** The run the claim opened, when it was asked to open one. */
  execution?: DbExecutionProcess
  /** The saved wakes that run took. */
  wakes?: DbTaskWake[]
}

/** The run a claim opens, written with the claim. */
export interface ClaimRun {
  executorType: string
  /** Why it runs. A saved wake it takes names the reason instead. */
  runReason?: string | null
  workspaceId?: string | null
}

/** Build a new `running` execution row. */
function buildExecutionRow(input: CreateExecInput, id: string, now: number): DbExecutionProcess {
  return {
    id,
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
    costSource: null,
    runtime: null,
    summary: null,
    runReason: input.runReason ?? null,
    error: null,
    errorClass: null,
    madeProgress: null,
    recoveryTombstone: 0,
    tenantId: null,
    createdAt: now,
  }
}

/**
 * Atomically claim a `todo` task for a single assignee. The guard
 * `status='todo' AND assignee IS NULL AND dropped=0` means at most one caller
 * wins; the loser gets `{ ok:false, reason:'conflict' }` and MUST NOT retry
 * (the "never retry a 409" rule). Transient lock errors ARE retried inside.
 *
 * With `opts.run`, the claim opens the run in the same transaction: the execution
 * row, the stamp on the task (`runExecutionId`) and the hand-over of the saved wakes
 * waiting on it all commit together or not at all. It is also refused while a run is
 * still open on the task, whoever released it: ONE LIVE RUN PER TASK, enforced here
 * rather than in any one engine because other processes write this file too. Such a
 * run ends on its own, or the stale sweep closes it. A claim with no `run` (the REST
 * claim, MCP `claim_task`) starts nothing, so it has no stamp until a run is opened.
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
  opts: { run?: ClaimRun } = {},
): ClaimResult {
  const now = Date.now()
  const result = immediateWrite(db, (tx): ClaimResult => {
    // Every claim passes here, so a paused agent, team or task tree (see ./pauses)
    // starts no work whichever path asked. The task stays in To do. Read inside the
    // write, on its one connection, so a pause placed just before it is seen.
    // A person's task says so below: it is theirs whatever is paused.
    const target = tx
      .select({ teamId: tasks.teamId, person: tasks.assigneePersonId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get()
    if (
      target &&
      !target.person &&
      startRefusedBy(db, { agentId: assigneeAgentId, teamId: target.teamId, taskId }) !== null
    ) {
      return { ok: false, reason: 'paused' }
    }
    const run = opts.run
    if (run) {
      const live = tx
        .select({ id: executionProcesses.id })
        .from(executionProcesses)
        .where(and(eq(executionProcesses.taskId, taskId), eq(executionProcesses.status, 'running')))
        .get()
      if (live) return { ok: false, reason: 'conflict' }
    }
    const execId = run ? randomUUID() : null
    const claimed = tx
      .update(tasks)
      .set({
        assigneeAgentId,
        assigneeRuntime: assigneeRuntime ?? null,
        status: 'in_progress',
        updatedAt: now,
        runExecutionId: execId,
      })
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.status, 'todo'),
          isNull(tasks.assigneeAgentId),
          // A person's task is theirs: every claim, on every path, comes through here.
          isNull(tasks.assigneePersonId),
          eq(tasks.dropped, 0),
        ),
      )
      .returning()
      .all() as DbTask[]

    if (claimed.length === 0) {
      const held = tx
        .select({ person: tasks.assigneePersonId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get()
      if (!held) return { ok: false, reason: 'not_found' }
      return { ok: false, reason: held.person ? 'person_assigned' : 'conflict' }
    }
    if (!run || !execId) return { ok: true, task: claimed[0] }
    const wakes = adoptTaskWakesTx(tx, taskId, execId, now)
    const strongest = wakes.reduce<(typeof wakes)[number] | undefined>(
      (best, w) => (best && strongerWakeReason(best.reason, w.reason) === best.reason ? best : w),
      undefined,
    )
    const execution = buildExecutionRow(
      {
        taskId,
        executorType: run.executorType,
        workspaceId: run.workspaceId ?? null,
        runReason: strongest?.reason ?? run.runReason ?? null,
      },
      execId,
      now,
    )
    tx.insert(executionProcesses).values(execution).run()
    return { ok: true, task: claimed[0], execution, wakes }
  })
  if (result.ok && result.task)
    emitBoardLifecycle({
      kind: 'task_claimed',
      taskId,
      teamId: result.task.teamId ?? null,
      assigneeAgentId,
    })
  return result
}

/** How often a drain loop beats a running task. A TIMER, not a throttle: the
 *  beat must not ride observed events, or a run that is working silently stops
 *  proving it is alive. The stale-sweep TTL must comfortably exceed this. */
export const TASK_HEARTBEAT_MS = 30_000

/**
 * The ready-pump's fire policy over an execution ledger, as the server's pump
 * scan reads it: fireable unless the last run was `cancelled` (user Stop, never
 * auto-refired), the trailing streak of unsuccessful runs reached the cap, or the
 * no-progress brake is holding it back. The rule itself lives in @clawboo/board-core, shared with the engine's own pump, so
 * the scan and the engine cannot disagree about what will run.
 */
export const isLedgerAutoFireable: (execs: readonly LedgerRun[]) => boolean = ledgerAllowsAutoFire

/**
 * The (team, room) pairs that have at least one FIREABLE delegation: a READY
 * (deps-satisfied, `todo`, non-dropped) task whose sourceDelegationId carries the
 * `:agent:` target marker AND whose execution ledger permits an auto-fire. The
 * server dispatch pump scans this to know WHICH team orchestrators to (re)build
 * and pump; a room has its own orchestrator, so the room is part of the answer
 * (`roomId` null = the team's default room). Precision matters three times over:
 * without the ledger filter one permanently-parked task would rebuild its
 * orchestrator every tick forever, without the readiness filter a dep-blocked
 * plan tail would do the same, and without the pause check so would paused work
 * or a task left on an archived team. The engine's own policy remains the final
 * arbiter of what runs.
 */
export function listRoomsWithFireableDelegations(
  db: ClawbooDb,
): Array<{ teamId: string; roomId: string | null }> {
  const candidates = db
    .selectDistinct({ teamId: tasks.teamId, roomId: tasks.roomId })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'todo'),
        eq(tasks.dropped, 0),
        like(tasks.sourceDelegationId, '%:agent:%'),
      ),
    )
    .all() as Array<{ teamId: string | null; roomId: string | null }>
  const out: Array<{ teamId: string; roomId: string | null }> = []
  for (const c of candidates) {
    if (!c.teamId) continue
    // Readiness (deps satisfied) comes from the same query the engine's pump
    // uses, so the two views can't drift.
    const ready = getReadyTasks(db, { teamId: c.teamId, roomId: c.roomId })
    for (const t of ready) {
      if (!/:agent:/.test(t.sourceDelegationId ?? '')) continue
      if (!isLedgerAutoFireable(listExecutions(db, t.id))) continue
      if (startRefusedByTask(db, t) !== null) continue
      out.push({ teamId: c.teamId, roomId: c.roomId })
      break
    }
  }
  return out
}

/** The teams among `listRoomsWithFireableDelegations`, any room. */
export function listTeamsWithFireableDelegations(db: ClawbooDb): string[] {
  return [...new Set(listRoomsWithFireableDelegations(db).map((r) => r.teamId))]
}

/**
 * Rooms holding a task In review whose last run is still open under the team
 * engine (executor type `openclaw`): a team-chat work check under way, or one a
 * restart cut short. The dispatch pump builds such a room's engine when none is
 * loaded, and the engine's `resume()` hands the interrupted ones to a person. A
 * task-runner task in review has a runner execution and is not listed.
 */
export function listRoomsWithEngineTasksInReview(
  db: ClawbooDb,
): Array<{ teamId: string; roomId: string | null }> {
  const rows = db
    .select({ id: tasks.id, teamId: tasks.teamId, roomId: tasks.roomId })
    .from(tasks)
    .where(and(eq(tasks.status, 'in_review'), eq(tasks.dropped, 0)))
    .all() as Array<{ id: string; teamId: string | null; roomId: string | null }>
  const rooms = new Map<string, { teamId: string; roomId: string | null }>()
  for (const r of rows) {
    if (!r.teamId) continue
    const last = listExecutions(db, r.id).at(-1)
    if (!last || last.status !== 'running' || last.executorType !== 'openclaw') continue
    rooms.set(`${r.teamId}\u0000${r.roomId ?? ''}`, { teamId: r.teamId, roomId: r.roomId })
  }
  return [...rooms.values()]
}

/**
 * Liveness heartbeat for a running task: bump `updatedAt` — the exact column
 * `reconcileStaleInProgress` keys on — so an actively-driven run is never swept
 * as stale, and the sweep TTL can be minutes instead of an hour. Guarded on
 * `in_progress` (a beat racing a release/completion no-ops, never resurrecting
 * freshness) and, when given, on the assignee — so a stale driver from a
 * PREVIOUS claim can't keep beating a task that was released and re-claimed by
 * someone else, masking the new run's death. With `execId`, only that run counts: a
 * driver from an earlier run by the SAME agent cannot keep a newer run looking alive.
 */
export function heartbeatTask(
  db: ClawbooDb,
  taskId: string,
  opts?: { assigneeAgentId?: string; execId?: string | null },
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
          ...(opts?.execId ? [eq(tasks.runExecutionId, opts.execId)] : []),
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
 *
 * `execId` names the run being driven. A function is read at each beat, for a driver
 * whose run changes under it (the task runner's fix cycles) or that starts beating
 * before its claim: while it answers null there is no run to prove, so nothing beats.
 */
export function startTaskHeartbeat(
  db: ClawbooDb,
  taskId: string,
  opts?: { assigneeAgentId?: string; execId?: string | null | (() => string | null) },
): () => void {
  const beat = (): void => {
    try {
      const execId = typeof opts?.execId === 'function' ? opts.execId() : (opts?.execId ?? null)
      if (typeof opts?.execId === 'function' && !execId) return
      heartbeatTask(db, taskId, { assigneeAgentId: opts?.assigneeAgentId, execId })
    } catch {
      /* a missed beat must never break the owner */
    }
  }
  beat()
  const timer = setInterval(beat, TASK_HEARTBEAT_MS)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}

/**
 * The same beat for a task In review, which {@link heartbeatTask} leaves alone. The
 * task runner keeps its run open while the run's work is checked, and a check can
 * take many minutes, so it beats through the check: {@link reconcileStaleInReview}
 * and the boot reap read a silent one as a run that died with its process. Guarded
 * like the other beat, on the status and, when given, the assignee.
 */
export function startReviewHeartbeat(
  db: ClawbooDb,
  taskId: string,
  opts?: { assigneeAgentId?: string },
): () => void {
  const beat = (): void => {
    try {
      withWriteRetry(() =>
        db
          .update(tasks)
          .set({ updatedAt: Date.now() })
          .where(
            and(
              eq(tasks.id, taskId),
              eq(tasks.status, 'in_review'),
              ...(opts?.assigneeAgentId ? [eq(tasks.assigneeAgentId, opts.assigneeAgentId)] : []),
            ),
          )
          .run(),
      )
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
        waitingOn: null,
        runExecutionId: null,
        status: 'todo',
        updatedAt: Date.now(),
      })
      // A person working their own task In progress has not left it to the queue.
      .where(
        and(eq(tasks.id, taskId), eq(tasks.status, 'in_progress'), isNull(tasks.assigneePersonId)),
      )
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

export type UpdateStatusReason =
  | 'not_found'
  | 'illegal_transition'
  | 'verification_required'
  | 'invalid_completed_at'
  | 'person_moved'
  | 'person_assigned'
  | 'awaiting_answer'
  | 'blocker_cancelled'
export interface UpdateStatusResult {
  ok: boolean
  task?: DbTask
  reason?: UpdateStatusReason
  /** The status the write moved the task from, read in the same transaction. Set
   *  when `ok`. */
  from?: TaskStatus
}

/** Status-transition options. Default `{}` ⇒ the intrinsic verification gate
 *  applies; `humanOverride` is the explicit, audited escape hatch (the caller
 *  records the override). */
export interface UpdateStatusOptions {
  /** Bypass the intrinsic `→done` verification gate. The ONLY way a task with a
   *  non-promotable verdict can reach `done`; the caller MUST audit the override. */
  humanOverride?: boolean
  /** When a move to `done` or `cancelled` finished, if not now: a person marking
   *  work done on the day it was really done. It must fall between the task's
   *  creation and now, else the move is refused with `invalid_completed_at`.
   *  Ignored for any other status. */
  completedAt?: number
  /** Who made the move, carried on the lifecycle event. `person` is a human
   *  moving the card (the board, the task drawer), which the engine treats as
   *  the final word on that task: it stops the run and does not report its
   *  late result as the task's outcome. The move's time is kept on the task
   *  (`personMovedAt`). */
  actor?: 'person'
  /** An agent's own write (its task tools). Refused with `person_moved` when a
   *  person moved the card after the task's latest run started: that run was
   *  overruled, and its status write would put the card back where the person
   *  took it from. A run started after the move writes as usual. Refused too while
   *  the turn is a person's: `person_assigned` for a task they hold, and
   *  `awaiting_answer` while it waits on their answer to a question. Here and not in
   *  the tools, because every tool that moves a card comes through this write. */
  unlessPersonMoved?: boolean
  /** What the task now waits for. Absent: a move to another status clears the old
   *  reason, and a repeat of the same status keeps it. Required at the agent
   *  surface, never here: system writers and a person's move may give none. */
  waitingOn?: WaitingOn | null
  /** Done or Cancelled back to To do. Only with `actor: 'person'`, and only the
   *  Reopen route passes it, which is why it is an option and not a table edge. */
  reopen?: boolean
  /** A cancel that follows from a person's cancel of the step this one waits on. It
   *  frees the task's slot under its parent as their own cancel does, without being
   *  a move of this card (see `personCancelledAt`). */
  byPersonCascade?: boolean
}

/** When the task's latest run started (its newest execution's start, claim or
 *  creation), or null when it never ran. */
function latestRunStart(tx: ClawbooDb | BoardTx, taskId: string): number | null {
  const row = tx
    .select({
      at: sql<
        number | null
      >`max(coalesce(${executionProcesses.startedAt}, ${executionProcesses.claimedAt}, ${executionProcesses.createdAt}))`,
    })
    .from(executionProcesses)
    .where(eq(executionProcesses.taskId, taskId))
    .get()
  return row?.at ?? null
}

/** A person moved the card after this task's latest run started (or it never ran),
 *  so that run, and any agent write from it, was overruled. */
export function personMovedSinceLastRun(tx: ClawbooDb | BoardTx, row: DbTask): boolean {
  if (row.personMovedAt == null) return false
  const lastRun = latestRunStart(tx, row.id)
  return lastRun == null || row.personMovedAt > lastRun
}

/** A routine fires this task, whoever owns the schedule. Its person may be away, and
 *  its next fire needs the task back in To do, so it never waits on a person. */
export function firedByRoutine(row: Pick<DbTask, 'scheduledBy'>): boolean {
  return row.scheduledBy !== 'manual'
}

/** A task this one depends on will never finish: cancelled, or dropped before it was
 *  done. `getReadyTasks` needs every dependency done, so nothing would start this one. */
function hasCancelledBlocker(tx: BoardTx, taskId: string): boolean {
  return (
    tx
      .select({ id: tasks.id })
      .from(taskDeps)
      .innerJoin(tasks, eq(tasks.id, taskDeps.dependsOnTaskId))
      .where(
        and(
          eq(taskDeps.taskId, taskId),
          sql`(${tasks.status} = 'cancelled' OR (${tasks.dropped} = 1 AND ${tasks.status} != 'done'))`,
        ),
      )
      .get() !== undefined
  )
}

/**
 * A person reopened this task, so what its earlier runs did no longer speaks for it.
 * The keys its runs made their sub-tasks under stop answering, or the next run's
 * sub-tasks would come back as the old ones, finished. Its agent's failure count on it
 * goes too, or the breaker would refuse handing it out again over failures a person
 * has just looked past. A key that points at this task stays: the task is open again.
 */
function freshStartForReopenedTx(tx: BoardTx, row: DbTask): void {
  tx.delete(taskCreateKeys)
    .where(
      or(
        like(taskCreateKeys.key, `mcp-task:${row.id}:%`),
        like(taskCreateKeys.key, `mcp:task:${row.id}:%`),
      ),
    )
    .run()
  const agentId = delegationTargetOf(row.sourceDelegationId) ?? row.assigneeAgentId
  if (row.teamId && agentId)
    tx.delete(delegationFailures)
      .where(
        and(
          eq(delegationFailures.teamId, row.teamId),
          eq(delegationFailures.targetAgentId, agentId),
          eq(delegationFailures.taskKey, delegationFailureKey(agentId, row.title)),
        ),
      )
      .run()
}

/** How far ahead of the server clock a person's finish time may be (clock skew
 *  between their browser and this machine). */
const COMPLETED_AT_SKEW_MS = 5 * 60_000

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
  const waitersReleased: BoardLifecycleEvent[] = []
  const dependentsWoken: Array<{ taskId: string; teamId: string | null }> = []
  const result = immediateWrite(db, (tx): UpdateStatusResult => {
    const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as DbTask | undefined
    if (!row) return { ok: false, reason: 'not_found' }
    if (opts.unlessPersonMoved) {
      if (row.assigneePersonId) return { ok: false, reason: 'person_assigned', task: row }
      if (parseWaitingOn(row.waitingOn)?.kind === 'question')
        return { ok: false, reason: 'awaiting_answer', task: row }
      if (personMovedSinceLastRun(tx, row)) return { ok: false, reason: 'person_moved', task: row }
    }
    const from = row.status as TaskStatus
    const personMove =
      opts.actor === 'person' &&
      personMoveAllowed(from, to, {
        ...(opts.reopen === true ? { reopen: true } : {}),
        personAssigned: row.assigneePersonId != null,
      })
    if (!canTransition(from, to) && !personMove) return { ok: false, reason: 'illegal_transition' }
    // Reopen is that one move: a task that is not finished has nothing to reopen.
    if (opts.reopen === true && !personMove) return { ok: false, reason: 'illegal_transition' }
    // Back in To do it would look queued, and nothing would ever start it.
    if (opts.reopen === true && hasCancelledBlocker(tx, taskId))
      return { ok: false, reason: 'blocker_cancelled', task: row }
    if (to === 'done' && !opts.humanOverride && !verdictCellPromotable(row.verification)) {
      return { ok: false, reason: 'verification_required' }
    }
    const now = Date.now()
    // A finish time is recorded once, when the task first reaches done or
    // cancelled. Writing the same terminal status again (a run's late result
    // after a person already marked the task done) must not move it to now.
    const finishing = isTerminal(to) && from !== to
    let completedAt = now
    if (finishing && opts.completedAt !== undefined) {
      const at = opts.completedAt
      if (!Number.isFinite(at) || at < row.createdAt || at > now + COMPLETED_AT_SKEW_MS)
        return { ok: false, reason: 'invalid_completed_at' }
      completedAt = Math.min(at, now)
    }
    const reopening = personMove && opts.reopen === true
    tx.update(tasks)
      .set({
        status: to,
        updatedAt: now,
        ...(finishing ? { completedAt } : {}),
        // Finished again later, it records that finish: the calendar reads this. And
        // it holds its slot under its parent again.
        ...(reopening ? { completedAt: null, personCancelledAt: null } : {}),
        ...(opts.waitingOn !== undefined
          ? { waitingOn: waitingOnJson(opts.waitingOn) }
          : from !== to
            ? { waitingOn: null }
            : {}),
        ...(opts.actor === 'person' ? { personMovedAt: now } : {}),
        // A person's cancel frees the task's slot under its parent. An agent's frees
        // nothing, and cancelled is terminal, so a slot never comes back.
        ...(to === 'cancelled' && (opts.actor === 'person' || opts.byPersonCascade)
          ? { personCancelledAt: now }
          : {}),
        // A check waits only inside In review (see `setTaskCheckHeld`).
        ...(to !== 'in_review' ? { checkHeldSince: null } : {}),
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
        // Let go, so no run holds it. A run on a task moved anywhere else (In
        // review, Blocked) keeps the stamp until it closes.
        ...(to === 'todo' || isTerminal(to) ? { runExecutionId: null } : {}),
      })
      .where(eq(tasks.id, taskId))
      .run()
    // A dependency moving to done, on any path: its wakes commit with it.
    if (to === 'done' && from !== 'done')
      dependentsWoken.push(...recordDependencyWakesTx(tx, taskId, now))
    if (reopening) freshStartForReopenedTx(tx, row)
    const updated = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as DbTask
    // A question lasts only while the task waits on it: any move ends it, and so does
    // any other reason written over it. Else it stays open with nothing waiting on it,
    // and shows up again under a later reason.
    if (from !== to || (opts.waitingOn !== undefined && opts.waitingOn?.kind !== 'question'))
      expirePendingQuestionsTx(tx, taskId, isTerminal(to) ? 'task_closed' : 'moved', now)
    if (isTerminal(to) && from !== to)
      waitersReleased.push(...releaseWaitersTx(tx, updated, to, now))
    return { ok: true, task: updated, from }
  })
  if (result.ok && result.task)
    emitBoardLifecycle({
      kind: 'status_changed',
      taskId,
      teamId: result.task.teamId ?? null,
      status: to,
      ...(opts.actor ? { actor: opts.actor } : {}),
    })
  noteWaitersReleased(db, waitersReleased)
  for (const woken of dependentsWoken)
    emitBoardLifecycle({ kind: 'task_wake_recorded', ...woken, reason: 'dependency_done' })
  return result
}

/** Publish what a closing task freed, post-commit. The event log is what browser
 *  alerts follow, and a task that came to a person must announce itself. */
function noteWaitersReleased(db: ClawbooDb, events: BoardLifecycleEvent[]): void {
  for (const ev of events) {
    emitBoardLifecycle(ev)
    if (ev.kind !== 'status_changed' && ev.kind !== 'task_released') continue
    try {
      appendEvent(db, {
        kind: 'status_changed',
        taskId: ev.taskId,
        teamId: ev.teamId,
        data: {
          to: ev.kind === 'status_changed' ? ev.status : 'todo',
          reason: 'wait_over',
        },
      })
    } catch {
      // Best-effort: the move stands, and the board shows it at its next read.
    }
  }
}

/**
 * The way out for a task waiting on other work. `closed` just reached Done or
 * Cancelled, or was dropped, inside this transaction: the tasks waiting on it, and a
 * parent waiting on its sub-tasks once this was the last one open, stop waiting. In
 * the write itself, not on the in-process bus, because an MCP stdio bin writes this
 * file too and a crash right after the write must not leave them waiting forever.
 *
 * One bound to an agent goes back to To do, which is what wakes that agent: the
 * dispatch pump fires it. Anything else goes to a person, who is told why: a blocker
 * that was cancelled is a decision, a task nothing would start needs someone to start
 * it, and a run still open on it would read a move to To do as being taken off the
 * task. The single wiring point for waking on a cleared reason.
 */
function releaseWaitersTx(
  tx: BoardTx,
  closed: DbTask,
  to: TaskStatus,
  now: number,
): BoardLifecycleEvent[] {
  const events: BoardLifecycleEvent[] = []
  const finished = to === 'done'
  const name = `“${closed.title}”`
  const release = (waiter: DbTask, ready: boolean, note: string, ifNot: string): void => {
    const runOpen = tx
      .select({ id: executionProcesses.id })
      .from(executionProcesses)
      .where(
        and(eq(executionProcesses.taskId, waiter.id), eq(executionProcesses.status, 'running')),
      )
      .get()
    const toQueue = ready && !runOpen && delegationTargetOf(waiter.sourceDelegationId) !== null
    const moved = tx
      .update(tasks)
      .set(
        toQueue
          ? {
              status: 'todo',
              waitingOn: null,
              assigneeAgentId: null,
              assigneeRuntime: null,
              verification: null,
              updatedAt: now,
            }
          : { waitingOn: waitingOnJson({ kind: 'person', need: ifNot }), updatedAt: now },
      )
      .where(and(eq(tasks.id, waiter.id), eq(tasks.status, 'blocked')))
      .run()
    if (moved.changes === 0) return
    // Saved in this write, so the pump's rules decide when it starts and the run's
    // "Why this run" line says why, as for a dependency.
    if (toQueue)
      recordTaskWakeTx(
        tx,
        {
          teamId: waiter.teamId ?? null,
          agentId: delegationTargetOf(waiter.sourceDelegationId) as string,
          taskId: waiter.id,
          reason: 'dependency_done',
        },
        now,
      )
    tx.insert(taskComments)
      .values({
        id: randomUUID(),
        taskId: waiter.id,
        authorAgentId: null,
        authorType: 'system',
        body: toQueue ? note : ifNot,
        tenantId: null,
        createdAt: now,
      })
      .run()
    const teamId = waiter.teamId ?? null
    events.push(
      toQueue
        ? { kind: 'task_released', taskId: waiter.id, teamId, via: 'release' }
        : { kind: 'status_changed', taskId: waiter.id, teamId, status: 'blocked' },
      ...(toQueue
        ? [
            {
              kind: 'task_wake_recorded' as const,
              taskId: waiter.id,
              teamId,
              reason: 'dependency_done' as const,
            },
          ]
        : []),
      {
        kind: 'comment_added',
        taskId: waiter.id,
        teamId,
        authorType: 'system',
        authorAgentId: null,
      },
    )
  }

  const waiting = tx
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.status, 'blocked'), eq(tasks.dropped, 0), like(tasks.waitingOn, '%"task"%')),
    )
    .all() as DbTask[]
  for (const waiter of waiting) {
    const w = parseWaitingOn(waiter.waitingOn)
    if (w?.kind !== 'task' || w.taskId !== closed.id) continue
    release(
      waiter,
      finished,
      `${name}, the task this waited on, is done.`,
      finished
        ? `${name}, the task this waited on, is done, and nothing started this one again. Retry it or decide what happens next.`
        : `${name}, the task this waited on, was cancelled. Decide what happens next.`,
    )
  }

  if (closed.parentTaskId) {
    const parent = tx.select().from(tasks).where(eq(tasks.id, closed.parentTaskId)).get() as
      DbTask | undefined
    if (parent && parent.status === 'blocked' && !parent.dropped) {
      if (parseWaitingOn(parent.waitingOn)?.kind === 'subtasks') {
        const open = tx
          .select({ n: count() })
          .from(tasks)
          .where(
            and(
              eq(tasks.parentTaskId, parent.id),
              eq(tasks.dropped, 0),
              sql`${tasks.status} NOT IN ('done', 'cancelled')`,
            ),
          )
          .get()
        if ((open?.n ?? 0) === 0) {
          // Any that did not get done was a decision, as a cancelled blocker is. That
          // takes in one dropped while open, and leaves out one dropped once done.
          const unfinished = tx
            .select({ n: count() })
            .from(tasks)
            .where(and(eq(tasks.parentTaskId, parent.id), sql`${tasks.status} != 'done'`))
            .get()
          const allDone = (unfinished?.n ?? 0) === 0
          release(
            parent,
            allDone,
            'All the sub-tasks this waited on are done.',
            allDone
              ? 'All the sub-tasks this waited on are done, and nothing started this one again. Retry it or decide what happens next.'
              : 'A sub-task this waited on was cancelled or removed, and none is still open. Decide what happens next.',
          )
        }
      }
    }
  }
  return events
}

/** Say why a task that stayed Blocked is still here, when a person's action could not
 *  move it. Only while it is Blocked: a task that moved on has its own reason. */
export function noteBlockedReason(db: ClawbooDb, taskId: string, waitingOn: WaitingOn): void {
  withWriteRetry(() =>
    db
      .update(tasks)
      .set({ waitingOn: waitingOnJson(waitingOn), updatedAt: Date.now() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, 'blocked')))
      .run(),
  )
}

/** What a task waiting on other work waits on, for its card to name: the task's
 *  title, or how many of its sub-tasks are open. Undefined for any other wait. */
export function waitingOnDetailOf(
  db: ClawbooDb,
  task: Pick<DbTask, 'id' | 'waitingOn'>,
): { taskTitle?: string; openSubtasks?: number } | undefined {
  const w = parseWaitingOn(task.waitingOn)
  if (w?.kind === 'task') return { taskTitle: getTask(db, w.taskId)?.title ?? '' }
  if (w?.kind === 'subtasks') return { openSubtasks: countOpenSubtasks(db, task.id) }
  return undefined
}

/**
 * Say what a task waits for without moving it: for a check whose move to Blocked
 * keeps failing, which would otherwise sit there with no reason. Only while it is
 * still In progress or In review; a task that moved on has its own reason.
 */
export function setTaskWaitingOn(db: ClawbooDb, taskId: string, waitingOn: WaitingOn | null): void {
  withWriteRetry(() =>
    db
      .update(tasks)
      .set({ waitingOn: waitingOnJson(waitingOn) })
      .where(and(eq(tasks.id, taskId), inArray(tasks.status, ['in_progress', 'in_review'])))
      .run(),
  )
}

/** Update non-status metadata (priority / title / description). Status changes
 *  must go through `updateStatus` so the state machine is enforced. Cost is not a
 *  field here: the run ledger records it (`recordExecutionUsage`). */
export interface TaskFields {
  /** Clamped to the four named levels, as at create. */
  priority?: number
  title?: string
  description?: string | null
  /** The agent's REAL runtime. The engine hardcodes `assigneeRuntime: 'openclaw'` at
   *  create; the orchestrator corrects it to the actual runtime for the card badge. */
  assigneeRuntime?: string | null
}

export function updateTaskFields(db: ClawbooDb, taskId: string, fields: TaskFields): DbTask | null {
  const patch: Partial<Pick<DbTask, 'priority' | 'title' | 'description' | 'assigneeRuntime'>> & {
    updatedAt: number
  } = {
    updatedAt: Date.now(),
  }
  if (fields.priority !== undefined) patch.priority = clampTaskPriority(fields.priority)
  if (fields.title !== undefined) patch.title = fields.title
  if (fields.description !== undefined) patch.description = fields.description
  if (fields.assigneeRuntime !== undefined) patch.assigneeRuntime = fields.assigneeRuntime
  withWriteRetry(() => db.update(tasks).set(patch).where(eq(tasks.id, taskId)).run())
  return getTask(db, taskId)
}

/** The statuses a person can hand a task over from: nothing is running it. An
 *  `in_progress` task qualifies only when it is stranded there (see
 *  `isStrandedInProgress`). */
const ASSIGNABLE_STATUSES: ReadonlySet<TaskStatus> = new Set(['todo', 'backlog', 'blocked'])

/** In progress with no agent on it and no run going: a card moved there by hand,
 *  which starts nothing. A person may hand it over or retry it like a stopped one. */
export function isStrandedInProgress(db: ClawbooDb | BoardTx, task: DbTask): boolean {
  if (task.status !== 'in_progress' || task.assigneeAgentId) return false
  const running = db
    .select({ id: executionProcesses.id })
    .from(executionProcesses)
    .where(and(eq(executionProcesses.taskId, task.id), eq(executionProcesses.status, 'running')))
    .get()
  return !running
}

export type AssignTaskResult =
  | { ok: true; task: DbTask; from: TaskStatus }
  | { ok: false; reason: 'not_found' | 'not_assignable' }

/**
 * Bind a task that is NOT running to the agent named in `sourceDelegationId` (a
 * person assigning it from the board) and release it to `todo` so it can run.
 * Both writes happen in ONE BEGIN IMMEDIATE transaction, so no other writer can
 * see, or be left with, a task bound to its new agent but still parked.
 *
 * Refused while the task is being worked, finished, cancelled or dropped:
 * re-binding a live run would leave its result reporting to an agent that no
 * longer owns the task. A task already in `todo` only changes its binding.
 */
export function assignTaskDelegation(
  db: ClawbooDb,
  taskId: string,
  sourceDelegationId: string,
): AssignTaskResult {
  // Post-commit emission, as in `updateStatus`: a subscriber never observes an
  // uncommitted transition.
  let hadPerson = false
  const result = immediateWrite(db, (tx): AssignTaskResult => {
    const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as DbTask | undefined
    if (!row) return { ok: false, reason: 'not_found' }
    const from = row.status as TaskStatus
    const assignable = ASSIGNABLE_STATUSES.has(from) || isStrandedInProgress(tx, row)
    if (row.dropped || !assignable || !canTransition(from, 'todo')) {
      return { ok: false, reason: 'not_assignable' }
    }
    hadPerson = row.assigneePersonId != null
    const now = Date.now()
    tx.update(tasks)
      .set({
        sourceDelegationId,
        updatedAt: now,
        // One assignee: the person who had it no longer does, and whatever it waited
        // on is over now that an agent will run it.
        assigneePersonId: null,
        assigneePerson: null,
        waitingOn: null,
        // Released for a fresh run: the same fields `updateStatus(→todo)` clears.
        ...(from !== 'todo'
          ? {
              status: 'todo',
              assigneeAgentId: null,
              assigneeRuntime: null,
              verification: null,
              checkHeldSince: null,
              runExecutionId: null,
            }
          : {}),
      })
      .where(eq(tasks.id, taskId))
      .run()
    expirePendingQuestionsTx(tx, taskId, 'moved', now)
    const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as DbTask
    return { ok: true, task, from }
  })
  if (result.ok && (result.from !== 'todo' || hadPerson))
    emitBoardLifecycle({
      kind: 'status_changed',
      taskId,
      teamId: result.task.teamId ?? null,
      status: 'todo',
    })
  return result
}

export type AssignPersonResult =
  | { ok: true; task: DbTask; from: TaskStatus }
  | { ok: false; reason: 'not_found' | 'not_assignable' }

/** A delegation id with its agent taken off: who delegated it still reads, and the
 *  dispatch pump and `delegationTargetOf` no longer see an agent. */
function withoutAgentBinding(sdid: string | null | undefined): string | null {
  if (!sdid) return null
  return sdid.replace(/:agent:[^:]*/, '')
}

/**
 * Give a task that is not running to a person, or with `null` take it off them. The
 * agent binding comes off with it, so nothing starts it and a later comment reaches
 * no agent: the person has taken the work. Refused while it is being worked,
 * finished, cancelled or dropped, as a hand-over to an agent is.
 */
export function assignTaskToPerson(
  db: ClawbooDb,
  taskId: string,
  person: PersonRecord | null,
): AssignPersonResult {
  const result = immediateWrite(db, (tx): AssignPersonResult => {
    const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as DbTask | undefined
    if (!row) return { ok: false, reason: 'not_found' }
    const from = row.status as TaskStatus
    const assignable = ASSIGNABLE_STATUSES.has(from) || isStrandedInProgress(tx, row)
    if (row.dropped || !assignable) return { ok: false, reason: 'not_assignable' }
    const now = Date.now()
    tx.update(tasks)
      .set({
        assigneePersonId: person?.id ?? null,
        assigneePerson: personJson(person),
        assigneeAgentId: null,
        assigneeRuntime: null,
        waitingOn: null,
        // Released, as any move to To do is: an earlier run's failing verdict must not
        // hold the person's Done, or the Done of an agent they give it to next.
        verification: null,
        // A person's move: a late write from the run it was taken from is overruled.
        personMovedAt: now,
        updatedAt: now,
        ...(person ? { sourceDelegationId: withoutAgentBinding(row.sourceDelegationId) } : {}),
        // Nothing runs a person's task, so it does not stay looking worked on, and a
        // task someone stopped waiting on is ready for them.
        ...(from === 'in_progress' || from === 'blocked' ? { status: 'todo' } : {}),
      })
      .where(eq(tasks.id, taskId))
      .run()
    expirePendingQuestionsTx(tx, taskId, 'moved', now)
    const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as DbTask
    return { ok: true, task, from }
  })
  // Who has it changed whether or not the status did: open views read it from this.
  if (result.ok)
    emitBoardLifecycle({
      kind: 'status_changed',
      taskId,
      teamId: result.task.teamId ?? null,
      status: result.task.status,
      actor: 'person',
    })
  return result
}

/**
 * Take a person off a handed-back task so its agent can run it again: a person's
 * Retry or reply gave the turn back. Its binding says which agent. A no-op when no
 * person has it.
 */
export function clearPersonAssignee(db: ClawbooDb, taskId: string): void {
  withWriteRetry(() =>
    db
      .update(tasks)
      .set({ assigneePersonId: null, assigneePerson: null })
      .where(eq(tasks.id, taskId))
      .run(),
  )
}

/** The person who asked for a task: on it, else on the nearest ancestor that says,
 *  else the built-in local person. */
function requesterOf(tx: BoardTx, task: DbTask): PersonRecord {
  const seen = new Set<string>([task.id])
  let at: DbTask | undefined = task
  while (at) {
    const asked = parsePersonJson(at.requestedBy)
    if (asked) return asked
    const parentId: string | null = at.parentTaskId
    if (!parentId || seen.has(parentId)) break
    seen.add(parentId)
    at = tx.select().from(tasks).where(eq(tasks.id, parentId)).get() as DbTask | undefined
  }
  return { ...LOCAL_PERSON }
}

export type HandBackResult =
  | { ok: true; task: DbTask; from: TaskStatus; person: PersonRecord }
  | {
      ok: false
      reason: 'not_found' | 'not_yours' | 'routine' | 'person_moved' | 'illegal_transition'
      task?: DbTask
    }

/**
 * An agent hands its own task back to the person who asked for it, saying what they
 * must do. Blocked, with the person as assignee and the agent's binding kept: the
 * agent stays who a person's reply or Retry goes to. The engine's self-block ending
 * then closes the run. One write, so the card never shows both assignees.
 */
export function handBackTask(
  db: ClawbooDb,
  taskId: string,
  input: { agentId: string; need: string; executionId?: string | null },
): HandBackResult {
  const result = immediateWrite(db, (tx): HandBackResult => {
    const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as DbTask | undefined
    if (!row) return { ok: false, reason: 'not_found' }
    if (row.assigneeAgentId !== input.agentId) return { ok: false, reason: 'not_yours', task: row }
    if (firedByRoutine(row)) return { ok: false, reason: 'routine', task: row }
    if (personMovedSinceLastRun(tx, row)) return { ok: false, reason: 'person_moved', task: row }
    const from = row.status as TaskStatus
    if (!canTransition(from, 'blocked')) return { ok: false, reason: 'illegal_transition' }
    const person = requesterOf(tx, row)
    const now = Date.now()
    // What the person must do now takes the place of any question still open.
    expirePendingQuestionsTx(tx, taskId, 'replaced', now)
    tx.update(tasks)
      .set({
        status: 'blocked',
        assigneePersonId: person.id,
        assigneePerson: personJson(person),
        assigneeAgentId: null,
        assigneeRuntime: null,
        waitingOn: waitingOnJson({
          kind: 'person',
          need: input.need,
          personId: person.id,
          by: 'agent',
        }),
        updatedAt: now,
      })
      .where(eq(tasks.id, taskId))
      .run()
    const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as DbTask
    return { ok: true, task, from, person }
  })
  if (result.ok) {
    emitBoardLifecycle({
      kind: 'status_changed',
      taskId,
      teamId: result.task.teamId ?? null,
      status: 'blocked',
    })
    // What browser alerts follow; this write can come from any process.
    try {
      appendEvent(db, {
        kind: 'status_changed',
        taskId,
        teamId: result.task.teamId ?? null,
        agentId: input.agentId,
        data: {
          to: 'blocked',
          reason: 'handed_back',
          actor: { kind: 'agent', agentId: input.agentId, execId: input.executionId ?? null },
        },
      })
    } catch {
      // The hand-back stands; the run's end announces it too.
    }
  }
  return result
}

/** A task's sub-tasks still open. */
export function openSubtasksOf(
  tx: ClawbooDb | BoardTx,
  taskId: string,
): Array<{ id: string; status: string }> {
  return tx
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(
      and(
        eq(tasks.parentTaskId, taskId),
        eq(tasks.dropped, 0),
        sql`${tasks.status} NOT IN ('done', 'cancelled')`,
      ),
    )
    .all()
}

/** How many of a task's sub-tasks are still open. */
export function countOpenSubtasks(db: ClawbooDb, taskId: string): number {
  const row = db
    .select({ n: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.parentTaskId, taskId),
        eq(tasks.dropped, 0),
        sql`${tasks.status} NOT IN ('done', 'cancelled')`,
      ),
    )
    .get()
  return row?.n ?? 0
}

/** A person reopens a finished task: Done or Cancelled back to To do. Only the
 *  person-only Reopen route calls this, and the finish time is cleared. */
export function reopenTask(db: ClawbooDb, taskId: string): UpdateStatusResult {
  return updateStatus(db, taskId, 'todo', { actor: 'person', reopen: true })
}

export function blockTask(
  db: ClawbooDb,
  taskId: string,
  opts: UpdateStatusOptions = {},
): UpdateStatusResult {
  return updateStatus(db, taskId, 'blocked', opts)
}

export function unblockTask(
  db: ClawbooDb,
  taskId: string,
  opts: UpdateStatusOptions = {},
): UpdateStatusResult {
  return updateStatus(db, taskId, 'todo', opts)
}

/** Soft-delete (auditable / restorable), never destructive. Its open questions
 *  close, and a task waiting on it stops waiting. */
export function dropTask(db: ClawbooDb, taskId: string): void {
  const released: BoardLifecycleEvent[] = []
  immediateWrite(db, (tx) => {
    const now = Date.now()
    tx.update(tasks).set({ dropped: 1, updatedAt: now }).where(eq(tasks.id, taskId)).run()
    expirePendingQuestionsTx(tx, taskId, 'task_closed', now)
    const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as DbTask | undefined
    if (row) released.push(...releaseWaitersTx(tx, row, 'cancelled', now))
  })
  noteWaitersReleased(db, released)
}

// ─── Dependencies (Beads-style blocks / blocked-by) ──────────────────────────

export class TaskDependencyCycleError extends Error {
  readonly code = 'task_dependency_cycle'

  constructor(taskId: string, dependsOnTaskId: string) {
    super(`linking ${taskId} to ${dependsOnTaskId} would create a dependency cycle`)
    this.name = 'TaskDependencyCycleError'
  }
}

/** Enough for any real board: a walk past this gives up and calls it no loop. */
const WAIT_WALK_MAX = 1_000

/**
 * Does finishing any of `from` need `to` to finish first? It follows what each open
 * task waits on (a task, or its open sub-tasks) and the dependencies it cannot start
 * without. True means a wait on `from` by `to` could never end.
 */
export function waitReaches(tx: ClawbooDb | BoardTx, from: readonly string[], to: string): boolean {
  const seen = new Set<string>()
  const queue = [...from]
  while (queue.length > 0 && seen.size < WAIT_WALK_MAX) {
    const at = queue.pop()!
    if (at === to) return true
    if (seen.has(at)) continue
    seen.add(at)
    const row = tx
      .select({ status: tasks.status, waitingOn: tasks.waitingOn })
      .from(tasks)
      .where(eq(tasks.id, at))
      .get()
    if (!row || isTerminal(row.status as TaskStatus)) continue
    const wait = parseWaitingOn(row.waitingOn)
    if (wait?.kind === 'task') queue.push(wait.taskId)
    if (wait?.kind === 'subtasks') queue.push(...openSubtasksOf(tx, at).map((s) => s.id))
    queue.push(
      ...tx
        .select({ id: taskDeps.dependsOnTaskId })
        .from(taskDeps)
        .where(eq(taskDeps.taskId, at))
        .all()
        .map((r) => r.id),
    )
  }
  return false
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
    if (reachable.length > 0 || waitReaches(tx, [dependsOnTaskId], taskId)) {
      throw new TaskDependencyCycleError(taskId, dependsOnTaskId)
    }
    tx.insert(taskDeps)
      .values({ taskId, dependsOnTaskId, tenantId: null })
      .onConflictDoNothing()
      .run()
  })
}

/** The tasks waiting directly on `taskId`. */
export function listDirectDependentIds(db: ClawbooDb, taskId: string): string[] {
  return db
    .select({ id: taskDeps.taskId })
    .from(taskDeps)
    .where(eq(taskDeps.dependsOnTaskId, taskId))
    .all()
    .map((r) => r.id)
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
export function cancelDependents(
  db: ClawbooDb,
  taskId: string,
  opts: { byPerson?: boolean } = {},
): DbTask[] {
  const cancelled: DbTask[] = []
  for (const dep of getDependents(db, taskId)) {
    if (dep.status !== 'todo' && dep.status !== 'backlog') continue
    const r = updateStatus(db, dep.id, 'cancelled', opts.byPerson ? { byPersonCascade: true } : {})
    if (r.ok && r.task) cancelled.push(r.task)
  }
  return cancelled
}

/** The tasks `taskId` waits on (its direct dependencies), oldest first. */
export function getDependencies(db: ClawbooDb, taskId: string): DbTask[] {
  return db
    .select({ task: tasks })
    .from(taskDeps)
    .innerJoin(tasks, eq(tasks.id, taskDeps.dependsOnTaskId))
    .where(eq(taskDeps.taskId, taskId))
    .orderBy(tasks.createdAt, tasks.id)
    .all()
    .map((r) => r.task as DbTask)
}

/**
 * Tasks ready to work: `todo`, not dropped, with every dependency `done`, in the
 * order they are served. The server scan and every engine read this one query, so
 * the two stay in step.
 *   1. Tasks that ran before and came back (released after a crash, a failure on
 *      its way to a retry, a run a pause stopped) lead, since their work is under
 *      way. A run a person stopped does not count: that was a decision.
 *   2. Then priority, aged (see `agedTaskPriority`), so low-priority work gets through
 *      newer work, though never past a person's Urgent. A priority stored before
 *      writes were clamped is read as the nearest level, so an old large value
 *      cannot jump the queue either.
 *   3. Then oldest first, by creation, so an edit moves nothing.
 */
export function getReadyTasks(
  db: ClawbooDb,
  filter: { teamId?: string; roomId?: RoomFilter; now?: number } & Scope = {},
): DbTask[] {
  const conds = [
    eq(tasks.status, 'todo'),
    eq(tasks.dropped, 0),
    // A person's task is never an agent's next job, so no pump starts it.
    isNull(tasks.assigneePersonId),
    sql`NOT EXISTS (SELECT 1 FROM task_deps d JOIN tasks dt ON dt.id = d.depends_on_task_id WHERE d.task_id = ${tasks.id} AND dt.status != 'done')`,
  ]
  if (filter.teamId) conds.push(eq(tasks.teamId, filter.teamId))
  const room = roomCondition(filter.roomId)
  if (room) conds.push(room)
  if (filter.tenantId) conds.push(eq(tasks.tenantId, filter.tenantId))
  return db
    .select()
    .from(tasks)
    .where(and(...conds))
    .orderBy(...readyOrder(filter.now ?? Date.now()))
    .all() as DbTask[]
}

/** Is every dependency of this task done? */
export function taskDependenciesDone(db: ClawbooDb, taskId: string): boolean {
  return (
    db
      .select({ id: taskDeps.dependsOnTaskId })
      .from(taskDeps)
      .innerJoin(tasks, eq(tasks.id, taskDeps.dependsOnTaskId))
      .where(and(eq(taskDeps.taskId, taskId), sql`${tasks.status} != 'done'`))
      .get() === undefined
  )
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
  /** The person whose request added it, when a sign-in proxy vouched for them, and
   *  what wrote it (see `CommentKind`), and the run that wrote it, when an agent's run
   *  did. No kind means it wakes no one. */
  opts: {
    person?: PersonRecord | null
    kind?: CommentKind | null
    executionId?: string | null
  } = {},
): DbTaskComment {
  const now = Date.now()
  const row: DbTaskComment = {
    id: randomUUID(),
    taskId,
    authorAgentId: authorAgentId ?? null,
    authorType,
    body,
    tenantId: null,
    person: personJson(opts.person),
    kind: opts.kind ?? null,
    steeredAt: null,
    executionId: opts.executionId ?? null,
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

/** A task's comments, oldest first. Two written in the same millisecond keep
 *  the order they were written in. */
export function getComments(db: ClawbooDb, taskId: string): DbTaskComment[] {
  return db
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .orderBy(taskComments.createdAt, sql`rowid`)
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

/**
 * Update a workspace's lifecycle status (active → archived on cleanup, → stale on
 * GC). `worktreePath` records where a rebuild put the checkout, when that is not
 * where the row said it was.
 */
export function updateWorkspaceStatus(
  db: ClawbooDb,
  workspaceId: string,
  status: WorkspaceStatus,
  opts: { lastUsedAt?: number; worktreePath?: string } = {},
): void {
  withWriteRetry(() =>
    db
      .update(workspaces)
      .set({
        status,
        ...(opts.lastUsedAt !== undefined ? { lastUsedAt: opts.lastUsedAt } : {}),
        ...(opts.worktreePath !== undefined ? { worktreePath: opts.worktreePath } : {}),
      })
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

/**
 * Open a run on a task. A task being held (In progress, or In review under a check)
 * is stamped with it in the same transaction, which is how a fix round moves the
 * stamp to its own execution and how a claim made with no run gets one. A task
 * nobody holds takes no stamp: that row is a Stop's tombstone or a ledger entry.
 */
export function createExecutionProcess(db: ClawbooDb, input: CreateExecInput): DbExecutionProcess {
  const now = Date.now()
  const row = buildExecutionRow(input, randomUUID(), now)
  immediateWrite(db, (tx) => {
    tx.insert(executionProcesses).values(row).run()
    // A run opening is activity: its first beat may be half a minute off, and a task
    // that sat waiting must not read as a dead run in between (a fix cycle's mutex wait).
    tx.update(tasks)
      .set({ runExecutionId: row.id, updatedAt: now })
      .where(and(eq(tasks.id, input.taskId), inArray(tasks.status, ['in_progress', 'in_review'])))
      .run()
  })
  return row
}

export interface CompleteExecOutcome {
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled'
  summary?: string | null
  error?: string | null
  /** The class the failure was filed under (`classifyError` in @clawboo/obs). */
  errorClass?: string | null
  /** A person ended this run: their Stop, or moving its card. Not stored. It is how
   *  the wakes the run carried tell that from the other `cancelled` closes (a budget
   *  cap, the circuit breaker, a runtime abort), which give them back to the pump. */
  byPerson?: boolean
  afterCommit?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  cacheRead?: number | null
  cacheWrite?: number | null
  costUsd?: number | null
  costSource?: RunCostSource | null
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
  const row = immediateWrite(db, (tx): DbExecutionProcess | null => {
    // A terminal ledger row is IMMUTABLE: only a still-`running` exec can be
    // completed. The ledger is the dispatch pump's fire-policy input, where
    // `cancelled` means "user Stop" — a late abort terminal overwriting an
    // already-swept (`timed_out`) row would reclassify infra death as user
    // intent and permanently park refireable work. First terminal wins, and a
    // loser closes nothing, so it returns null and its caller skips the
    // duplicate `execution_completed` it would otherwise append.
    const open = tx
      .select()
      .from(executionProcesses)
      .where(and(eq(executionProcesses.id, execId), eq(executionProcesses.status, 'running')))
      .get() as DbExecutionProcess | undefined
    if (!open) return null
    const task = tx.select().from(tasks).where(eq(tasks.id, open.taskId)).get() as
      DbTask | undefined
    const subTasks = tx
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.parentTaskId, open.taskId), sql`${tasks.createdAt} >= ${open.createdAt}`))
      .get() as { n: number } | undefined
    const progress = runMadeProgress({
      status: outcome.status,
      summary: outcome.summary ?? null,
      taskStatus: task?.status ?? '',
      subTasks: subTasks?.n ?? 0,
      errorClass: outcome.errorClass ?? null,
    })
    const closed = tx
      .update(executionProcesses)
      .set({
        status: outcome.status,
        completedAt: now,
        summary: outcome.summary ?? null,
        error: outcome.error ?? null,
        errorClass: outcome.errorClass ?? null,
        afterCommit: outcome.afterCommit ?? null,
        madeProgress: progress === null ? null : progress ? 1 : 0,
        // The engine closes its rows without a cost, and the drain records the cost
        // on the row separately (recordExecutionUsage), so a close must not erase
        // fields it was not given. An explicit null still clears.
        ...(outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
        ...(outcome.outputTokens !== undefined ? { outputTokens: outcome.outputTokens } : {}),
        ...(outcome.cacheRead !== undefined ? { cacheRead: outcome.cacheRead } : {}),
        ...(outcome.cacheWrite !== undefined ? { cacheWrite: outcome.cacheWrite } : {}),
        ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
        ...(outcome.costSource !== undefined ? { costSource: outcome.costSource } : {}),
      })
      .where(eq(executionProcesses.id, execId))
      .returning()
      .get() as DbExecutionProcess
    // No run holds the task now. A later run's stamp is not this run's to clear.
    tx.update(tasks)
      .set({ runExecutionId: null })
      .where(and(eq(tasks.id, open.taskId), eq(tasks.runExecutionId, execId)))
      .run()
    settleWakesOfClosedRunTx(tx, execId, outcome, now)
    // An explicit null clears the run's cost, which changes the task total only if
    // the run had a cost to clear. A close that never had one must not recompute the
    // total: that would wipe a task's cost from before the run ledger carried it.
    if (outcome.costUsd != null || (outcome.costUsd === null && open.costUsd != null))
      refreshTaskCostTx(tx, closed.taskId)
    return closed
  })
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

/**
 * Recompute `tasks.cost_usd` from the run ledger. The column is the task's total,
 * the sum of every run's recorded cost, kept for readers that sum tasks (fleet
 * spend). A recompute rather than an add, so rewriting a run's cost never counts
 * it twice. Leaves `updatedAt` alone: a cost landing is not an edit to the task.
 */
function refreshTaskCostTx(tx: BoardTx, taskId: string): void {
  const r = tx
    .select({ total: sql<number | null>`sum(${executionProcesses.costUsd})` })
    .from(executionProcesses)
    .where(eq(executionProcesses.taskId, taskId))
    .get()
  tx.update(tasks)
    .set({ costUsd: r?.total ?? 0 })
    .where(eq(tasks.id, taskId))
    .run()
}

/** What one run cost, as `recordExecutionUsage` writes it onto the run's row. */
export interface ExecutionUsage {
  costUsd: number
  costSource: RunCostSource
  inputTokens?: number | null
  outputTokens?: number | null
  /** The runtime that actually ran (see `executionProcesses.runtime`). */
  runtime?: string | null
}

/**
 * Record what a run cost on its execution row, whatever the row's status, because
 * a Stop (`markStopped`) or the idle watchdog closes the row before the run's own
 * terminal arrives. Touches only the cost, token and runtime columns: status,
 * completedAt, summary and error stay as the first terminal left them, which is the
 * fire-policy invariant `completeExecutionProcess` keeps. Refreshes the task's
 * total in the same transaction. Returns the updated row, or null when `execId`
 * matched nothing.
 */
export function recordExecutionUsage(
  db: ClawbooDb,
  execId: string,
  usage: ExecutionUsage,
): DbExecutionProcess | null {
  return immediateWrite(db, (tx) => {
    const rows = tx
      .update(executionProcesses)
      .set({
        costUsd: usage.costUsd,
        costSource: usage.costSource,
        ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(usage.runtime !== undefined ? { runtime: usage.runtime } : {}),
      })
      .where(eq(executionProcesses.id, execId))
      .returning()
      .all() as DbExecutionProcess[]
    const row = rows[0]
    if (!row) return null
    refreshTaskCostTx(tx, row.taskId)
    return row
  })
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

/**
 * The run ledgers of many tasks in one read, each oldest first. A task with no
 * runs maps to `[]`. Chunked so a large board never exceeds SQLite's bound
 * parameter limit.
 */
export function listExecutionsForTasks(
  db: ClawbooDb,
  taskIds: readonly string[],
): Map<string, DbExecutionProcess[]> {
  const out = new Map<string, DbExecutionProcess[]>()
  for (const id of taskIds) out.set(id, [])
  const unique = [...out.keys()]
  const CHUNK = 500
  for (let i = 0; i < unique.length; i += CHUNK) {
    const rows = db
      .select()
      .from(executionProcesses)
      .where(inArray(executionProcesses.taskId, unique.slice(i, i + CHUNK)))
      .orderBy(executionProcesses.createdAt)
      .all() as DbExecutionProcess[]
    for (const row of rows) out.get(row.taskId)?.push(row)
  }
  return out
}

// ─── Orphan reconciliation (startup recovery) ────────────────────────────────

export interface ReconcileResult {
  reconciled: number
}

/** A reconcile pass that can park a task in review, and which ones it parked, so
 *  the server can say so (the database layer has no event log or mailbox policy). */
export interface ParkedReviewsResult extends ReconcileResult {
  parked: Array<{ taskId: string; teamId: string | null; agentId: string | null }>
}

/** The comment on a task in review whose run stopped with the server. */
export const ORPHANED_REVIEW_NOTE =
  'The run working on this task stopped when Clawboo restarted while the task was in review, so it is waiting for you. Retry runs it again, or Dismiss drops it.'

/** The task's latest execution, the one `listExecutions` lists last. */
function latestExecutionId(tx: BoardTx, taskId: string): string | null {
  const row = tx
    .select({ id: executionProcesses.id })
    .from(executionProcesses)
    .where(eq(executionProcesses.taskId, taskId))
    .orderBy(desc(executionProcesses.createdAt))
    .get() as { id: string } | undefined
  return row?.id ?? null
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
 * auto-resume). An `in_progress` task is released to `todo`, so it runs again. An
 * `in_review` task goes to `blocked` (Needs you) with a system comment instead: it
 * was waiting on a review, a rerun could repeat finished work, and `in_review ->
 * todo` is not a legal move. Both follow the transition table. One BEGIN
 * IMMEDIATE txn.
 */
export function reconcileOrphans(
  db: ClawbooDb,
  opts?: { staleAfterMs?: number },
): ParkedReviewsResult {
  // Default: the same order of magnitude as the sweep TTL (6 missed beats).
  const staleAfterMs = opts?.staleAfterMs ?? 6 * TASK_HEARTBEAT_MS
  const releasedEvents: BoardLifecycleEvent[] = []
  const parkedReviews: ParkedReviewsResult['parked'] = []
  const result = immediateWrite(db, (tx): ParkedReviewsResult => {
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
      // A team-chat check does not beat, so its clock says nothing. Its next engine
      // parks it and tells whoever handed the task out (`resume`), which a raw park
      // here would take away. The same rows `listRoomsWithEngineTasksInReview` builds
      // an engine for, so none is left waiting on an engine that never comes.
      if (
        t?.status === 'in_review' &&
        t.teamId &&
        !t.dropped &&
        ex.executorType === 'openclaw' &&
        latestExecutionId(tx, t.id) === ex.id
      )
        return false
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
          error: ORPHANED_RUN_ERROR,
          recoveryTombstone: 1,
        })
        .where(eq(executionProcesses.id, ex.id))
        .run()
      // Whatever it carried goes back for the next run.
      settleWakesOfClosedRunTx(tx, ex.id, { status: 'failed' }, now)
      tx.update(tasks)
        .set({ runExecutionId: null })
        .where(and(eq(tasks.id, ex.taskId), eq(tasks.runExecutionId, ex.id)))
        .run()
      const released = tx
        .update(tasks)
        .set({
          assigneeAgentId: null,
          assigneeRuntime: null,
          verification: null,
          waitingOn: null,
          status: 'todo',
          updatedAt: now,
        })
        .where(and(eq(tasks.id, ex.taskId), eq(tasks.status, 'in_progress')))
        .returning({ teamId: tasks.teamId })
        .all() as Array<{ teamId: string | null }>
      // Publish only when the row actually changed — the guard can no-op (the
      // task already left in_progress) and a phantom release would wake pumps
      // for nothing.
      if (released.length > 0) {
        releasedEvents.push({
          kind: 'task_released',
          taskId: ex.taskId,
          teamId: released[0]!.teamId ?? null,
          via: 'orphan-reap',
        })
        continue
      }
      // Assignee and verdict stay, so the card still says whose work it is and
      // what any check found.
      const parked = tx
        .update(tasks)
        .set({
          status: 'blocked',
          waitingOn: waitingOnJson({ kind: 'recovery' }),
          updatedAt: now,
          checkHeldSince: null,
        })
        .where(and(eq(tasks.id, ex.taskId), eq(tasks.status, 'in_review')))
        .returning({ teamId: tasks.teamId, assigneeAgentId: tasks.assigneeAgentId })
        .all() as Array<{ teamId: string | null; assigneeAgentId: string | null }>
      if (parked.length > 0) {
        const teamId = parked[0]!.teamId ?? null
        parkedReviews.push({
          taskId: ex.taskId,
          teamId,
          agentId: parked[0]!.assigneeAgentId ?? null,
        })
        tx.insert(taskComments)
          .values({
            id: randomUUID(),
            taskId: ex.taskId,
            authorAgentId: null,
            authorType: 'system',
            body: ORPHANED_REVIEW_NOTE,
            tenantId: null,
            createdAt: now,
          })
          .run()
        releasedEvents.push(
          { kind: 'status_changed', taskId: ex.taskId, teamId, status: 'blocked' },
          {
            kind: 'comment_added',
            taskId: ex.taskId,
            teamId,
            authorType: 'system',
            authorAgentId: null,
          },
        )
      }
    }
    return { reconciled: orphans.length, parked: parkedReviews }
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
 *
 * It also closes a run left open behind a task someone released (an operator's
 * release, a move nothing observed): nothing beats a task in To do, so once such a
 * row is older than the TTL nothing proves it alive, and it would keep the claim
 * refusing and the fire policy reading "someone owns this". If the run does still
 * end, its late result takes the path it always did.
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
          error: STALE_RUN_ERROR,
        })
        .where(and(eq(executionProcesses.taskId, t.id), eq(executionProcesses.status, 'running')))
        .run()
      for (const r of running) settleWakesOfClosedRunTx(tx, r.id, { status: 'timed_out' }, now)
      tx.update(tasks)
        .set({
          assigneeAgentId: null,
          assigneeRuntime: null,
          verification: null,
          waitingOn: null,
          runExecutionId: null,
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
    const leaked = tx
      .select({ id: executionProcesses.id })
      .from(executionProcesses)
      .innerJoin(tasks, eq(tasks.id, executionProcesses.taskId))
      .where(
        and(
          eq(executionProcesses.status, 'running'),
          eq(tasks.status, 'todo'),
          lt(executionProcesses.createdAt, cutoff),
        ),
      )
      .all() as Array<{ id: string }>
    for (const r of leaked) {
      tx.update(executionProcesses)
        .set({ status: 'timed_out', completedAt: now, error: STALE_RUN_ERROR })
        .where(eq(executionProcesses.id, r.id))
        .run()
      settleWakesOfClosedRunTx(tx, r.id, { status: 'timed_out' }, now)
    }
    return { reconciled }
  })
  // Post-commit: subscribers must never see an uncommitted release.
  for (const ev of releasedEvents) emitBoardLifecycle(ev)
  return result
}

/**
 * The periodic backstop for a task In review whose task-runner run stopped beating:
 * its process died while the run's work was being checked, and a restart inside the
 * beat window left it to this pass (`reconcileOrphans` cannot yet tell it from a live
 * run). Nothing will finish that check, so the task goes to a person the way the boot
 * reap sends it, with the same row and note, so Needs you reads the same whichever
 * caught it. Only a runner's run, the one driver that beats a task in review: the team
 * engine parks its own interrupted checks (`listRoomsWithEngineTasksInReview`), and an
 * outside executor's silence says nothing about a restart. Idempotent (a parked task is
 * no longer in review).
 */
export function reconcileStaleInReview(db: ClawbooDb, olderThanMs: number): ParkedReviewsResult {
  const events: BoardLifecycleEvent[] = []
  const result = immediateWrite(db, (tx): ParkedReviewsResult => {
    const cutoff = Date.now() - olderThanMs
    const stale = tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.status, 'in_review'), eq(tasks.dropped, 0), lt(tasks.updatedAt, cutoff)))
      .all() as DbTask[]
    const now = Date.now()
    const parked: ParkedReviewsResult['parked'] = []
    for (const t of stale) {
      const running = tx
        .select({ id: executionProcesses.id, executorType: executionProcesses.executorType })
        .from(executionProcesses)
        .where(and(eq(executionProcesses.taskId, t.id), eq(executionProcesses.status, 'running')))
        .all()
      const runnerRuns = running.filter((r) => isTaskRunnerRun(t, r.executorType))
      if (runnerRuns.length === 0) continue
      tx.update(executionProcesses)
        .set({
          status: 'failed',
          completedAt: now,
          error: ORPHANED_RUN_ERROR,
          recoveryTombstone: 1,
        })
        .where(
          inArray(
            executionProcesses.id,
            runnerRuns.map((r) => r.id),
          ),
        )
        .run()
      for (const r of runnerRuns) settleWakesOfClosedRunTx(tx, r.id, { status: 'failed' }, now)
      tx.update(tasks)
        .set({
          status: 'blocked',
          waitingOn: waitingOnJson({ kind: 'recovery' }),
          runExecutionId: null,
          updatedAt: now,
        })
        .where(eq(tasks.id, t.id))
        .run()
      tx.insert(taskComments)
        .values({
          id: randomUUID(),
          taskId: t.id,
          authorAgentId: null,
          authorType: 'system',
          body: ORPHANED_REVIEW_NOTE,
          tenantId: null,
          createdAt: now,
        })
        .run()
      const teamId = t.teamId ?? null
      parked.push({ taskId: t.id, teamId, agentId: t.assigneeAgentId ?? null })
      events.push(
        { kind: 'status_changed', taskId: t.id, teamId, status: 'blocked' },
        { kind: 'comment_added', taskId: t.id, teamId, authorType: 'system', authorAgentId: null },
      )
    }
    return { reconciled: parked.length, parked }
  })
  // Post-commit: subscribers must never see an uncommitted move.
  for (const ev of events) emitBoardLifecycle(ev)
  return result
}
