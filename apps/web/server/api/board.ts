// ─── Durable board REST ─────────────────────────────────────
// Thin HTTP layer over @clawboo/db's board repository (the data boundary — no
// raw Drizzle here). Bodies are validated with the co-located zod schemas
// exported from @clawboo/db.

import type { Request, Response } from 'express'

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

import {
  clampAgentTaskPriority,
  commentMayWake,
  delegationTargetOf,
  encodeHumanAssignment,
  isHumanAssignment,
} from '@clawboo/board-core'
import {
  addComment,
  agents,
  appendAudit,
  assignTaskDelegation,
  attentionForTask,
  attentionForTasks,
  claimBody,
  clearPersonAssignee,
  claimTask,
  commentBody,
  completeExecutionBody,
  cancelDependents,
  closeMainTaskByPerson,
  isTerminal,
  mainTaskState,
  completeExecutionProcess,
  createExecutionBody,
  createExecutionProcess,
  createTask,
  createTaskBody,
  getAncestors,
  getComments,
  getReadyTasks,
  getTask,
  linkDep,
  linkDepBody,
  listExecutions,
  listTasks,
  provisionWorkspaceBody,
  listWaitingTaskWakes,
  readTaskRunnerInputs,
  runCostForTasks,
  runOwnWrite,
  runningSinceForTasks,
  TaskDependencyCycleError,
  updateStatus,
  updateTaskBody,
  updateTaskFields,
  workspaceActionBody,
  getWorkspaceForTask,
  isStrandedInProgress,
  labelsForTasks,
  pauseSubjectOfTask,
  setTaskLabels,
  startRefusedBy,
  taskLabelsBody,
  personMovedSinceLastRun,
  type ClawbooDb,
  pendingQuestionsForTasks,
  waitingOnDetailOf,
  wakeCommentIds,
  type DbTask,
  type DbTaskQuestion,
  type TaskLabel,
  type TaskRunCost,
  type TaskStatus,
  type UpdateStatusResult,
} from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import { agentHandoffSchema } from '@clawboo/worktrees'
import { eq } from 'drizzle-orm'

import { actingPerson, actorField, actsAsPerson, personOf, refuseUnlessPerson } from '../lib/auth'
import { ownWriterOf, withReadState } from '../lib/boardReader'
import { getDb } from '../lib/db'
import { engineHeld } from '../lib/engineHold'
import { loopbackMcpBaseUrl } from '../lib/mcpBaseUrl'
import { emitEvent } from '../lib/obs'
import { runnerRerunFor } from '../lib/runnerRerun'
import { taskRunSteering } from '../lib/runSteers'
import { runnerTargetOf } from '../lib/runnerRoute'
import { startTask } from '../lib/startBoardTask'
import { requestTaskDispatch } from '../lib/teamChat/boardDispatch'
import { getTaskOrchestrator } from '../lib/teamChat/teamOrchestrator'
import { noteHumanMove, statusWord } from '../lib/teamChat/humanMove'
import { reflectToRoom } from '../lib/teamChat/reflect'
import { deliverPersonReply, type ReplyDelivery } from '../lib/teamChat/personReply'
import { pauseViewOfTask, pauseViews, type PauseView } from '../lib/pauseViews'
import { engineRefusal } from '../lib/teamChat/roomRoster'
import { clearTaskSessionPointers } from '../lib/teamChat/taskSessionPointers'
import {
  actOnTaskWorkspace,
  getTaskWorkspace,
  provisionTaskWorkspace,
  readWorktreeDetail,
  writeTaskHandoff,
} from '../lib/worktrees'
import {
  agentTeamFolder,
  listTeamFolderDir,
  listWorkspaceDir,
  readTeamFolderFile,
  readWorkspaceFile,
  workspaceFileDiff,
  workspaceGitStatus,
  WorkspacePathError,
  type WorkspaceMissReason,
} from '../lib/workspaceFs'
import { openPreviewStream, resolvePreviewFile } from '../lib/workspacePreview'

const log = createLogger('board-api')

// ─── GET /api/board ──────────────────────────────────────────────────────────
// Query: teamId?, status?, ready?=true (deps satisfied), includeDropped?=true
export function boardListGET(req: Request, res: Response): void {
  try {
    const db = getDb()
    const teamId = typeof req.query['teamId'] === 'string' ? req.query['teamId'] : undefined
    if (req.query['ready'] === 'true') {
      res.json({ tasks: getReadyTasks(db, teamId ? { teamId } : {}) })
      return
    }
    const status =
      typeof req.query['status'] === 'string' ? (req.query['status'] as TaskStatus) : undefined
    const includeDropped = req.query['includeDropped'] === 'true'
    res.json({
      tasks: withPause(
        db,
        withOpenQuestion(
          db,
          withReadState(
            db,
            req,
            withLabels(
              db,
              withRunningSince(
                db,
                withRunCost(
                  db,
                  withAttention(db, listTasks(db, { teamId, status, includeDropped })),
                ),
              ),
            ),
          ),
        ),
      ),
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/board/:taskId ────────────────────────────────────────────────
// Returns the task plus its comments and ancestor chain.
export function boardGetGET(req: Request, res: Response): void {
  try {
    const db = getDb()
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const task = getTask(db, taskId)
    if (!task) {
      res.status(404).json({ error: 'task not found' })
      return
    }
    const [withWaiting] = withOpenQuestion(db, [task])
    res.json({
      task: {
        ...withReadState(db, req, [withWaiting!])[0]!,
        attention: attentionForTask(db, taskId),
        pause: pauseViewOfTask(db, task),
        runCost: runCostOf(db, task),
        // Whether a run is going, so the drawer can say a move stops it.
        runningSince: runningSinceForTasks(db, [taskId]).get(taskId) ?? null,
        // How the run on it takes a comment right now, for the composer's hint.
        runSteering: taskRunSteering(taskId),
        labels: labelsForTasks(db, [taskId]).get(taskId) ?? [],
        // A saved wake still waiting to reach its agent, and why it waits.
        pendingWake: pendingWakeOf(db, taskId),
      },
      comments: getComments(db, taskId),
      ancestors: getAncestors(db, taskId),
      ...(task.isMainTask === 1 ? { subtasks: subtasksForDetail(db, taskId) } : {}),
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

/** Each task with the pause covering it. Reads no more than the pauses when none is
 *  placed, the usual case. */
function withPause<T extends DbTask>(
  db: ClawbooDb,
  rows: T[],
): Array<T & { pause: PauseView | null }> {
  const views = pauseViews(db)
  return rows.map((t) => ({ ...t, pause: pauseViewOfTask(db, t, views) }))
}

/** What a request's drawer lists: everything filed under its main task, oldest first,
 *  with what a row needs to say how it stands. */
function subtasksForDetail(db: ClawbooDb, taskId: string): DbTask[] {
  const ids = mainTaskState(db, taskId)?.subtaskIds ?? []
  const rows = ids
    .map((id) => getTask(db, id))
    .filter((t): t is DbTask => t !== null)
    .sort((a, b) => a.createdAt - b.createdAt)
  return withRunCost(db, withAttention(db, rows))
}

/** The oldest saved wake still waiting on a task, for the drawer's line saying why:
 *  its reason, the reason the pump left it waiting (null before the pump has seen
 *  it), how many comments it carries, and whether a Stop holds it. */
function pendingWakeOf(
  db: ClawbooDb,
  taskId: string,
): { reason: string; skipReason: string | null; comments: number; held: boolean } | null {
  const row = listWaitingTaskWakes(db, { taskId, includeHeld: true })[0]
  return row
    ? {
        reason: row.reason,
        skipReason: row.skipReason,
        comments: wakeCommentIds(row).length,
        held: row.heldAt !== null,
      }
    : null
}

/** Each task with why it needs a person (`attention`, null when it does not), so
 *  the board can route it into its needs-you column without a request per card. */
function withAttention(db: ClawbooDb, rows: DbTask[]): Array<DbTask & { attention: unknown }> {
  const byId = attentionForTasks(db, rows)
  return rows.map((t) => ({ ...t, attention: byId.get(t.id) ?? null }))
}

/** Each task with the question it has open (`openQuestion`, null when none), so a
 *  card can show the answer controls without a request per card, and what a task
 *  waiting on other work waits on (`waitingOnDetail`), so its card can name it. */
function withOpenQuestion<T extends DbTask>(
  db: ClawbooDb,
  rows: T[],
): Array<
  T & {
    openQuestion: DbTaskQuestion | null
    waitingOnDetail?: { taskTitle?: string; openSubtasks?: number; needPerson?: number }
  }
> {
  const byId = pendingQuestionsForTasks(
    db,
    rows.filter((t) => t.waitingOn != null).map((t) => t.id),
  )
  return rows.map((t) => {
    const waitingOnDetail = waitingOnDetailOf(db, t)
    return {
      ...t,
      openQuestion: byId.get(t.id) ?? null,
      ...(waitingOnDetail ? { waitingOnDetail } : {}),
    }
  })
}

/** What a task with no recorded run cost carries. */
const NO_RUN_COST: TaskRunCost = { usd: null, estimated: false }

/** Each task with its labels, read in one query. */
function withLabels<T extends DbTask>(
  db: ClawbooDb,
  rows: T[],
): Array<T & { labels: TaskLabel[] }> {
  const byId = labelsForTasks(
    db,
    rows.map((t) => t.id),
  )
  return rows.map((t) => ({ ...t, labels: byId.get(t.id) ?? [] }))
}

/**
 * A priority as this caller may set it. Urgent is a person's call: anything but the
 * dashboard's own page stops at High, as an agent's create_task does. A speed bump
 * (see actsAsPerson), and the same one a person's comment goes through.
 */
function priorityFor(req: Request, priority: number | undefined): number | undefined {
  if (priority === undefined || actsAsPerson(req)) return priority
  return clampAgentTaskPriority(priority)
}

/** Each task with what its runs cost (`runCost`), summed from the run ledger in
 *  one read, so a card shows every run's cost and whether any of it is estimated. */
function withRunCost<T extends DbTask>(
  db: ClawbooDb,
  rows: T[],
): Array<T & { runCost: TaskRunCost }> {
  const byId = runCostForTasks(db, rows)
  return rows.map((t) => ({ ...t, runCost: byId.get(t.id) ?? NO_RUN_COST }))
}

/** Each task with when its current run started (`runningSince`, null when no run
 *  is live), so an In progress card can show how long it has been running. */
function withRunningSince<T extends DbTask>(
  db: ClawbooDb,
  rows: T[],
): Array<T & { runningSince: number | null }> {
  const byId = runningSinceForTasks(
    db,
    rows.map((t) => t.id),
  )
  return rows.map((t) => ({ ...t, runningSince: byId.get(t.id) ?? null }))
}

/** One task's `runCost` (see `withRunCost`). */
function runCostOf(db: ClawbooDb, task: DbTask): TaskRunCost {
  return runCostForTasks(db, [task]).get(task.id) ?? NO_RUN_COST
}

/** An active (not archived) member of `teamId`, or null. A person can hand a task
 *  only to someone on the team it belongs to: that team's orchestrator is the one
 *  that runs it. */
function teamMember(
  db: ClawbooDb,
  teamId: string,
  agentId: string,
): { id: string; name: string } | null {
  const row = db.select().from(agents).where(eq(agents.id, agentId)).get() as
    { id: string; name: string; teamId: string | null; archivedAt?: number | null } | undefined
  if (!row || row.archivedAt || row.teamId !== teamId) return null
  return { id: row.id, name: row.name }
}

/** Does this `sourceDelegationId` bind the task to an agent, say a person chose it,
 *  or name who hears its result? The engine fires and reports on these segments. */
function namesAnAgent(sourceDelegationId: string | undefined): boolean {
  if (!sourceDelegationId) return false
  return /:(?:agent|reflectTo):/.test(sourceDelegationId) || isHumanAssignment(sourceDelegationId)
}

// ─── POST /api/board ───────────────────────────────────────────────────────
// With `assigneeAgentId`, the task is created FOR that agent: it is bound to the
// agent (so the dispatcher can always find it again, after a restart too) and,
// when it starts in `todo`, handed to the team's orchestrator to run now. Its
// result reports to the person on its card; the team lead is not involved. That
// binding says a person chose, as Assign's does, so it takes a person's request.
// So does a `sourceDelegationId` that names an agent: the engine reads that value
// as the same binding, and fires it.
export function boardCreatePOST(req: Request, res: Response): void {
  try {
    const parsed = createTaskBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const db = getDb()
    const { assigneeAgentId, assignToMe, idempotencyKey, priority, ...input } = parsed.data
    if (assigneeAgentId && assignToMe) {
      res.status(400).json({ error: 'one_assignee' })
      return
    }
    if (
      (assigneeAgentId || assignToMe || namesAnAgent(input.sourceDelegationId)) &&
      refuseUnlessPerson(req, res)
    )
      return
    if (assigneeAgentId) {
      if (!input.teamId) {
        res.status(400).json({ error: 'team_required' })
        return
      }
      if (!teamMember(db, input.teamId, assigneeAgentId)) {
        res.status(400).json({ error: 'agent_not_in_team' })
        return
      }
      if (input.status && input.status !== 'todo' && input.status !== 'backlog') {
        res.status(400).json({ error: 'invalid_status' })
        return
      }
    }
    // Who asked for it, so a hand-back knows where to go. A verified person, or the
    // dashboard's own page; any other caller is not a person asking.
    const requestedBy = actsAsPerson(req) ? actingPerson(req) : null
    const allowedPriority = priorityFor(req, priority)
    const task = runOwnWrite(
      db,
      ownWriterOf(req),
      (t: DbTask) => t.id,
      () =>
        createTask(db, {
          ...input,
          ...(requestedBy ? { requestedBy } : {}),
          ...(assignToMe ? { assigneePerson: actingPerson(req) } : {}),
          ...(allowedPriority !== undefined ? { priority: allowedPriority } : {}),
          // Kept to its team, so a key cannot fetch another team's task.
          ...(idempotencyKey
            ? { createKey: { key: `rest:${input.teamId ?? ''}:${idempotencyKey}` } }
            : {}),
          ...(assigneeAgentId
            ? {
                status: input.status ?? 'todo',
                sourceDelegationId: encodeHumanAssignment(
                  assigneeAgentId,
                  randomUUID().slice(0, 8),
                ),
              }
            : {}),
        }),
    )
    // A retried draft: it was logged and started the first time.
    if (task.deduplicated) {
      res.json({
        task: { ...task, attention: attentionForTask(db, task.id), runCost: runCostOf(db, task) },
        deduplicated: true,
      })
      return
    }
    // Observability: emit self-gates → no-op when obs is off.
    emitEvent(db, {
      kind: 'task_created',
      taskId: task.id,
      teamId: task.teamId,
      agentId: assigneeAgentId ?? null,
      data: {
        title: task.title,
        status: task.status,
        parentTaskId: task.parentTaskId,
        ...actorField(req),
      },
    })
    if (assigneeAgentId && task.teamId && task.status === 'todo') {
      requestTaskDispatch(task.teamId, task.id, loopbackMcpBaseUrl(req))
    }
    res.json({
      task: { ...task, attention: attentionForTask(db, task.id), runCost: runCostOf(db, task) },
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── PUT /api/board/:taskId/labels ──────────────────────────────────────────
// Body: { labelIds }. Replaces the task's labels, all from its own team's. A person's
// call, so it takes a person's request (see actsAsPerson).
export function boardTaskLabelsPUT(req: Request, res: Response): void {
  if (refuseUnlessPerson(req, res)) return
  const parsed = taskLabelsBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
    return
  }
  try {
    const db = getDb()
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const result = setTaskLabels(db, taskId, parsed.data.labelIds)
    if (!result.ok) {
      res.status(result.reason === 'not_found' ? 404 : 409).json({ error: result.reason })
      return
    }
    const task = getTask(db, taskId)
    appendAudit(db, {
      eventType: 'board',
      taskId,
      teamId: task?.teamId ?? null,
      summary: {
        action: 'set_task_labels',
        labels: result.labels.map((l) => l.name),
        ...actorField(req),
      },
    })
    res.json({ labels: result.labels })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/board/:taskId/retry ──────────────────────────────────────────
// Run a task again because a person asked: one that failed, timed out, was
// stopped, was parked after failing repeatedly, or was left in progress with
// nothing running it. It goes back to `todo` (which
// clears the old assignee and verdict) and straight to its bound agent, past the
// automatic pump's "don't keep re-firing this" policy: that policy exists to stop
// the MACHINE retrying forever, not to overrule the person.
//
// A task the task runner ran goes back through the runner with the inputs it
// saved (see lib/runnerRerun), so it keeps its worktree and verification; its
// agent is the one bound to it, else the one the runner ran it for. Any other
// task goes to its team's chat, which needs an agent bound to it.
//
// Only a person's request: a retry overrules the machine's limits on the person's
// word. Any other caller gets 403, and can move the task to To do with the PATCH
// below, where those limits still apply.
export function boardRetryPOST(req: Request, res: Response): void {
  try {
    if (refuseUnlessPerson(req, res)) return
    const db = getDb()
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const task = getTask(db, taskId)
    if (!task) {
      res.status(404).json({ ok: false, error: 'task not found' })
      return
    }
    // A person's main task never runs by itself: its sub-tasks are what retry.
    if (task.isMainTask === 1) {
      res.status(409).json({ ok: false, error: 'main_task' })
      return
    }
    const retryable =
      task.status === 'todo' ||
      task.status === 'blocked' ||
      task.status === 'backlog' ||
      isStrandedInProgress(db, task)
    if (!retryable) {
      res.status(409).json({ ok: false, error: 'not_retryable' })
      return
    }
    const bound = delegationTargetOf(task.sourceDelegationId)
    const candidate = bound ?? readTaskRunnerInputs(task)?.assigneeAgentId ?? null
    const rerun = candidate ? runnerRerunFor(db, task, candidate) : null
    // The agent the runner ran it for counts only for a runner rerun: team chat
    // fires a task by its binding, and has nothing to run without one.
    const agentId = rerun ? candidate : bound
    if (!rerun && !task.teamId) {
      res.status(409).json({ ok: false, error: 'no_team' })
      return
    }
    if (!agentId) {
      res.status(409).json({ ok: false, error: 'unassigned' })
      return
    }
    // Team chat would hand it to an engine that cannot see it: refuse before
    // anything is written, rather than answer that it started.
    const refusal = rerun ? null : engineRefusal(db, task)
    if (refusal) {
      res.status(409).json({ ok: false, error: refusal })
      return
    }
    // A pause covers it: resuming is what starts it. Nothing is written, so the
    // card stays as it is and says who paused it.
    if (startRefusedBy(db, { ...pauseSubjectOfTask(task), agentId })) {
      res.status(409).json({ ok: false, error: 'paused' })
      return
    }
    // A handed-back task's turn goes back to its agent: one assignee, never both.
    if (task.assigneePersonId) clearPersonAssignee(db, taskId)
    if (task.status !== 'todo') {
      const moved = runOwnWrite(db, ownWriterOf(req), taskId, () =>
        updateStatus(db, taskId, 'todo'),
      )
      if (!moved.ok) {
        res.status(409).json({ ok: false, error: moved.reason })
        return
      }
      emitEvent(db, {
        kind: 'status_changed',
        taskId,
        teamId: task.teamId,
        data: { to: 'todo', reason: 'retry', ...actorField(req) },
      })
    }
    runOwnWrite(db, ownWriterOf(req), taskId, () =>
      addComment(db, taskId, 'Retry requested.', 'user', null, {
        kind: 'note',
        person: personOf(req),
      }),
    )
    startTask(db, taskId, task.teamId, rerun ? { agentId, rerun } : null, loopbackMcpBaseUrl(req))
    res.status(202).json({ ok: true, task: getTask(db, taskId) })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
}

// ─── POST /api/board/:taskId/assign ─────────────────────────────────────────
// Hand a task nobody is working on to one agent on its team, and start it. For a
// card no agent will ever pick up (created without one, or made by an agent's own
// `create_task`), and for re-routing a failed task to someone else. A task the
// task runner ran is run by the runner again, on the new agent's runtime, when
// that runtime is one the runner drives (see the Retry note above).
//
// Only a person's request, like Retry: the binding it writes says a person chose.
export function boardAssignPOST(req: Request, res: Response): void {
  try {
    if (refuseUnlessPerson(req, res)) return
    const db = getDb()
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const body = req.body as { agentId?: unknown } | undefined
    const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : ''
    if (!agentId) {
      res.status(400).json({ ok: false, error: 'agentId required' })
      return
    }
    const task = getTask(db, taskId)
    if (!task) {
      res.status(404).json({ ok: false, error: 'task not found' })
      return
    }
    if (!task.teamId) {
      res.status(409).json({ ok: false, error: 'no_team' })
      return
    }
    const member = teamMember(db, task.teamId, agentId)
    if (!member) {
      res.status(400).json({ ok: false, error: 'agent_not_in_team' })
      return
    }
    const rerun = runnerRerunFor(db, task, agentId)
    // Team chat would hand it to an engine that cannot see it: refuse before the
    // new binding is written, rather than answer that it starts now.
    const refusal = rerun ? null : engineRefusal(db, task)
    if (refusal) {
      res.status(409).json({ ok: false, error: refusal })
      return
    }
    // The new binding and the release to `todo` commit together or not at all.
    const assigned = runOwnWrite(db, ownWriterOf(req), taskId, () =>
      assignTaskDelegation(db, taskId, encodeHumanAssignment(agentId, randomUUID().slice(0, 8))),
    )
    if (!assigned.ok) {
      if (assigned.reason === 'not_found') {
        res.status(404).json({ ok: false, error: 'task not found' })
        return
      }
      // Running, finished, cancelled or dropped: nothing to hand over.
      res.status(409).json({ ok: false, error: 'not_assignable' })
      return
    }
    if (assigned.from !== 'todo') {
      emitEvent(db, {
        kind: 'status_changed',
        taskId,
        teamId: task.teamId,
        data: { to: 'todo', reason: 'assigned', ...actorField(req) },
      })
    }
    // Given to someone else, the task starts fresh: no agent resumes a
    // conversation about it from before, the new one or one it comes back to.
    // Assigned again to the same agent, it is a retry, and keeps its session.
    if (delegationTargetOf(task.sourceDelegationId) !== agentId) {
      try {
        clearTaskSessionPointers(db, taskId)
      } catch (err) {
        // The new binding is saved, so failing now would leave the task assigned
        // and never started. A pointer left behind is the earlier agent's: the
        // new one starts fresh regardless.
        log.error({ err, taskId }, 'clearing the task resume pointers failed')
      }
    }
    runOwnWrite(db, ownWriterOf(req), taskId, () =>
      addComment(db, taskId, `Assigned to ${member.name}.`, 'user', null, {
        kind: 'note',
        person: personOf(req),
      }),
    )
    startTask(db, taskId, task.teamId, rerun ? { agentId, rerun } : null, loopbackMcpBaseUrl(req))
    res.json({ ok: true, task: getTask(db, taskId) })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
}

// ─── POST /api/board/:taskId/claim ───────────────────────────────────────────
// Atomic single-assignee claim. 409 on conflict — the client MUST NOT retry.
export function boardClaimPOST(req: Request, res: Response): void {
  try {
    const parsed = claimBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const db = getDb()
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const result = claimTask(db, taskId, parsed.data.assigneeAgentId, parsed.data.assigneeRuntime)
    if (result.ok) {
      const t = result.task
      if (t) {
        emitEvent(db, {
          kind: 'task_claimed',
          taskId: t.id,
          teamId: t.teamId,
          agentId: t.assigneeAgentId,
          runtime: t.assigneeRuntime,
          data: {
            assigneeAgentId: t.assigneeAgentId,
            assigneeRuntime: t.assigneeRuntime,
            ...actorField(req),
          },
        })
        // Narrate the claim into the team room (fan-out to N peers; best-effort,
        // AFTER the canonical board write; never a write path back).
        reflectToRoom(
          db,
          t.teamId,
          `Task "${t.title}" claimed by ${t.assigneeAgentId ?? 'an agent'}.`,
        )
      }
      res.json({ ok: true, task: t })
      return
    }
    res.status(result.reason === 'not_found' ? 404 : 409).json({ ok: false, error: result.reason })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── PATCH /api/board/:taskId ────────────────────────────────────────────────
// Status change (state-machine enforced; 409 on illegal transition) and/or
// metadata (priority / title / description). This is a PERSON's route (the
// board, the task drawer): their move stops the run working on the task, a
// cancel takes the plan steps waiting on it with it, and a move to Done or
// Cancelled may say which day it finished (`completedAt`).
//
// A caller the person check does not let through still moves the card, as an
// agent's own status write does, without the person's authority: it stops no run,
// cannot overrule a person's move or the verification gate, and is not recorded as
// a person.
export function boardUpdatePATCH(req: Request, res: Response): void {
  try {
    const parsed = updateTaskBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const db = getDb()
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const { status, humanOverride: overrideAsked, completedAt, priority, ...rest } = parsed.data
    const byPerson = actsAsPerson(req)
    const humanOverride = byPerson && overrideAsked
    const allowedPriority = priorityFor(req, priority)
    const fields = {
      ...rest,
      ...(allowedPriority !== undefined ? { priority: allowedPriority } : {}),
    }

    let priorStatus: string | null = null
    let cancelledDependents: Array<{ id: string; title: string }> = []
    // A person closing their request closes the work under it, first, so no pump can
    // start any of it after the request is gone.
    const closedWithRequest: Array<{ task: DbTask; from: string }> = []
    if (status) {
      // The verification gate is intrinsic to `updateStatus`; `humanOverride`
      // (a human shipping despite a non-promotable verdict) is the only bypass —
      // record it in the audit log so the override is never silent.
      const before = getTask(db, taskId)
      priorStatus = before?.status ?? null
      const writer = ownWriterOf(req)
      let result: UpdateStatusResult
      if (
        byPerson &&
        before?.isMainTask === 1 &&
        (status === 'done' || status === 'cancelled') &&
        !isTerminal(before.status as TaskStatus)
      ) {
        // The request and the work under it close in one write, or neither does.
        const open = mainTaskState(db, taskId)?.subtaskIds ?? []
        const was = new Map(open.map((id) => [id, getTask(db, id)?.status ?? 'todo']))
        const closing = runOwnWrite(db, writer, taskId, () =>
          closeMainTaskByPerson(db, taskId, status, {
            ...(completedAt !== undefined ? { completedAt } : {}),
            ...(humanOverride ? { humanOverride: true } : {}),
            asOwnWrite: (id, write) => runOwnWrite(db, writer, id, write),
          }),
        )
        result = closing.result
        for (const t of closing.cancelled)
          closedWithRequest.push({ task: t, from: was.get(t.id) ?? t.status })
      } else {
        result = runOwnWrite(db, writer, taskId, () =>
          updateStatus(db, taskId, status, {
            ...(byPerson ? { actor: 'person' as const } : { unlessPersonMoved: true }),
            // A person's own move to Blocked: theirs to decide, so it reads back as that.
            ...(byPerson && status === 'blocked'
              ? {
                  waitingOn: {
                    kind: 'person' as const,
                    need: 'A person moved it here.',
                    by: 'person' as const,
                  },
                }
              : {}),
            ...(humanOverride ? { humanOverride: true } : {}),
            ...(completedAt !== undefined ? { completedAt } : {}),
          }),
        )
      }
      if (!result.ok) {
        res
          .status(
            result.reason === 'not_found'
              ? 404
              : result.reason === 'invalid_completed_at'
                ? 400
                : 409,
          )
          .json({ ok: false, error: result.reason })
        return
      }
      // A cancelled step can never be done, so the plan steps waiting on it never
      // could run either: cancel them with it rather than leave them looking
      // queued forever.
      if (status === 'cancelled' && priorStatus !== 'cancelled') {
        cancelledDependents = cancelDependents(db, taskId, { byPerson: true }).map((d) => ({
          id: d.id,
          title: d.title,
        }))
      }
      if (humanOverride && status === 'done') {
        const t = result.task
        appendAudit(db, {
          eventType: 'verification',
          taskId,
          teamId: t?.teamId ?? null,
          agentId: t?.assigneeAgentId ?? null,
          summary: { override: true, route: 'board_patch', priorStatus, to: 'done' },
        })
      }
    }
    const hasFields = Object.keys(fields).length > 0
    const task = hasFields
      ? runOwnWrite(db, ownWriterOf(req), taskId, () => updateTaskFields(db, taskId, fields))
      : getTask(db, taskId)
    if (!task) {
      res.status(404).json({ error: 'task not found' })
      return
    }
    if (status) {
      emitEvent(db, {
        kind: 'status_changed',
        taskId,
        teamId: task.teamId,
        agentId: task.assigneeAgentId,
        data: { to: status, ...(byPerson ? { by: 'person' } : {}), ...actorField(req) },
      })
      // Narrate the mutation into the team room (fan-out to N peers).
      // Best-effort, AFTER the canonical board write; never a write path back.
      reflectToRoom(
        db,
        task.teamId,
        `${byPerson ? 'A person' : 'A local API call'} moved "${task.title}" to ${statusWord(status)}.`,
      )
      if (byPerson && status !== priorStatus) {
        noteHumanMove(db, {
          taskId,
          teamId: task.teamId,
          from: priorStatus,
          to: status,
          cancelledDependents,
        })
      }
      for (const { task: closed, from } of closedWithRequest) {
        emitEvent(db, {
          kind: 'status_changed',
          taskId: closed.id,
          teamId: closed.teamId,
          data: { to: 'cancelled', reason: 'request_closed', by: 'person', ...actorField(req) },
        })
        noteHumanMove(db, {
          taskId: closed.id,
          teamId: closed.teamId,
          from,
          to: 'cancelled',
          withItsRequest: true,
        })
      }
      cancelledDependents = [
        ...cancelledDependents,
        ...closedWithRequest.map(({ task: t }) => ({ id: t.id, title: t.title })),
      ]
    }
    res.json({
      ok: true,
      task,
      ...(status === 'cancelled' || closedWithRequest.length > 0 ? { cancelledDependents } : {}),
      // Told so the dashboard can say so, if this was a person it could not recognise.
      ...(status && !byPerson ? { byPerson: false } : {}),
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/board/:taskId/comments ────────────────────────────────────────
export async function boardCommentPOST(req: Request, res: Response): Promise<void> {
  try {
    const parsed = commentBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const db = getDb()
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    // A person's comment goes into the assignee's live run as the person
    // steering it, so 'user' is honoured only for a request that passes the person
    // check. Any other caller gets an agent comment, which steers nothing. The same
    // for 'system': a later run reads that as clawboo itself. A speed bump, not a
    // boundary: see actsAsPerson.
    const authorType = actsAsPerson(req) ? parsed.data.authorType : 'agent'
    const ownWriter = ownWriterOf(req)
    const comment = runOwnWrite(db, authorType === 'user' ? ownWriter : null, taskId, () =>
      addComment(
        db,
        taskId,
        parsed.data.body,
        authorType,
        parsed.data.authorAgentId,
        // Set here, by the writer: a person's comment is one that passed the check.
        // What may wake an agent is read from this, never from the author type.
        { person: personOf(req), ...(authorType === 'user' ? { kind: 'person' as const } : {}) },
      ),
    )
    emitEvent(db, {
      kind: 'comment_added',
      taskId,
      agentId: parsed.data.authorAgentId ?? null,
      data: { authorType, body: parsed.data.body, ...actorField(req) },
    })
    // Narrate the comment into the team room so every peer sees it, not just the
    // leader (best-effort, AFTER the canonical write; never a write path back).
    const task = getTask(db, taskId)
    let delivery: ReplyDelivery | null = null
    if (task) {
      const author = parsed.data.authorAgentId ?? authorType
      reflectToRoom(
        db,
        task.teamId,
        `${author} on "${task.title}": ${parsed.data.body.slice(0, 160)}`,
      )
      // A comment that may wake its agent is a reply to the agent the task belongs
      // to: deliver it, starting the task again when it waits on the person, and say
      // where it went (see personReply). Any other comment wakes no one.
      if (commentMayWake(comment)) {
        const mcpBaseUrl = loopbackMcpBaseUrl(req)
        try {
          delivery = await deliverPersonReply(
            db,
            task,
            { id: comment.id, body: parsed.data.body },
            {
              dispatch: (teamId, id) => {
                const current = getTask(db, id)
                startTask(db, id, teamId, current ? runnerTargetOf(db, current) : null, mcpBaseUrl)
              },
              // As Retry: team chat could not run a task its engine cannot see.
              startRefusal: (t) => (runnerTargetOf(db, t) ? null : engineRefusal(db, t)),
              held: engineHeld,
              // Restarting it for the reply is part of the person's own write.
              asOwnWrite: (write) => runOwnWrite(db, ownWriter, taskId, write),
              commentOnRequest: (t, words) =>
                t.teamId
                  ? getTaskOrchestrator(t.teamId, t.id, {
                      mcpBaseUrl,
                      db,
                    }).personCommentedOnMainTask(t.id, words)
                  : Promise.resolve(false),
            },
          )
        } catch (err) {
          // The comment is saved: say it was not delivered rather than fail the
          // request, which would have the person send it a second time.
          log.error({ err, taskId }, 'delivering a person reply failed')
          delivery = {
            status: 'not-delivered',
            agentId: task.assigneeAgentId ?? delegationTargetOf(task.sourceDelegationId),
            reason: 'failed',
          }
        }
      }
    }
    res.json({
      ok: true,
      comment,
      forwarded: delivery != null && delivery.status !== 'not-delivered',
      ...(delivery ? { delivery } : {}),
      // A person's reply that did not pass as one, so the dashboard can say so.
      ...(parsed.data.authorType === 'user' && authorType !== 'user' ? { byPerson: false } : {}),
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/board/:taskId/executions ──────────────────────────────────────
// Record a spawned run for a task (after a successful claim). The exec ledger is
// what orphan reconciliation reads on restart, so an executor that starts work
// MUST open one here and close it via the PATCH below.
export function boardExecutionCreatePOST(req: Request, res: Response): void {
  try {
    const parsed = createExecutionBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const db = getDb()
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const task = getTask(db, taskId)
    if (!task) {
      res.status(404).json({ error: 'task not found' })
      return
    }
    // A person's main task runs nothing, so it holds no run to count or fail.
    if (task.isMainTask === 1) {
      res.status(409).json({ ok: false, error: 'main_task' })
      return
    }
    // A new run ends a person's hold on the card (see updateStatus), so without a
    // person's authority it would take this and one PATCH to undo their move.
    if (!actsAsPerson(req) && personMovedSinceLastRun(db, task)) {
      res.status(409).json({ ok: false, error: 'person_moved' })
      return
    }
    const execution = createExecutionProcess(db, { taskId, ...parsed.data })
    emitEvent(db, {
      kind: 'execution_started',
      taskId,
      teamId: task.teamId,
      agentId: task.assigneeAgentId,
      runtime: execution.executorType,
      data: { execId: execution.id, executorType: execution.executorType },
    })
    res.json({ ok: true, execution })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── PATCH /api/board/executions/:execId ──────────────────────────────────────
// Close out a run with its outcome + optional token/cost ledger.
export function boardExecutionCompletePATCH(req: Request, res: Response): void {
  try {
    const parsed = completeExecutionBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const db = getDb()
    const execId = (req.params['execId'] as string | undefined) ?? ''
    // The request carries only an execId, but the closed row carries its taskId,
    // so the correlation columns ARE recoverable here. Emitting without them
    // stranded this event: `projectFleetHealth` skips any event with no agentId,
    // so the open-run counter never decremented and a finished agent read as a
    // permanent zombie. "Correlate by execId" was never implemented downstream.
    const exec = completeExecutionProcess(db, execId, parsed.data)
    // `execId` is a raw path param, so an unknown one reaches here. Nothing was
    // closed, so answer 404 rather than reporting success, and above all do not
    // append a completion for a run that never ended.
    if (!exec) {
      res.status(404).json({ error: 'execution not found' })
      return
    }
    const task = getTask(db, exec.taskId)
    emitEvent(db, {
      kind: 'execution_completed',
      taskId: exec.taskId,
      teamId: task?.teamId ?? null,
      agentId: task?.assigneeAgentId ?? null,
      runtime: exec.executorType,
      data: {
        execId,
        status: parsed.data.status,
        costUsd: parsed.data.costUsd ?? null,
        error: parsed.data.error ?? null,
      },
    })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/board/:taskId/deps ─────────────────────────────────────────────
// Link a dependency: `taskId` won't become ready until `dependsOnTaskId` is done.
// Plans become a dep chain; the orchestrator's ready-pump fires the next step
// when the blocker completes.
export function boardLinkDepPOST(req: Request, res: Response): void {
  try {
    const parsed = linkDepBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const db = getDb()
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    // Guard against orphan dep rows: both endpoints of the edge must exist.
    const task = getTask(db, taskId)
    const dependsOn = getTask(db, parsed.data.dependsOnTaskId)
    if (!task || !dependsOn) {
      res.status(404).json({ error: 'task not found' })
      return
    }
    try {
      linkDep(db, taskId, parsed.data.dependsOnTaskId)
    } catch (err) {
      // A cycle is a client mistake, not a server fault: 409 like the claim
      // conflict, so the caller learns the plan is unworkable instead of seeing a
      // stringified exception behind a 500.
      if (err instanceof TaskDependencyCycleError) {
        res.status(409).json({ ok: false, error: err.code })
        return
      }
      throw err
    }
    emitEvent(db, {
      kind: 'dep_linked',
      taskId,
      data: { dependsOnTaskId: parsed.data.dependsOnTaskId, ...actorField(req) },
    })
    // Narrate the dependency into the team room (best-effort, after the write).
    reflectToRoom(db, task.teamId, `Task "${task.title}" now depends on "${dependsOn.title}".`)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/board/:taskId/cancel-dependents ───────────────────────────────
// Cancel the still-pending downstream chain of a FAILED task (a blocked/failed
// blocker can never become `done`, so its dependents are dead). Returns the
// cancelled tasks so the orchestrator can tell the leader the plan chain stalled.
export function boardCancelDependentsPOST(req: Request, res: Response): void {
  try {
    const db = getDb()
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    if (!getTask(db, taskId)) {
      res.status(404).json({ error: 'task not found' })
      return
    }
    const cancelled = cancelDependents(db, taskId)
    for (const t of cancelled) {
      emitEvent(db, {
        kind: 'status_changed',
        taskId: t.id,
        teamId: t.teamId,
        data: { to: 'cancelled', reason: 'blocker_failed', ...actorField(req) },
      })
    }
    res.json({ cancelled: cancelled.map((t) => ({ id: t.id, title: t.title })) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── Per-task worktree system-of-record ──────────────────
// Always registered (the durable board + worktree subsystem is unconditionally
// on). These endpoints provision / inspect / pause / complete a task's worktree.

// ─── POST /api/board/:taskId/workspace ───────────────────────────────────────
// Provision a worktree + branch + SoR scaffold for a file-mutating task and
// record the refs on the board. A read-only/research task is refused (422) — it
// should not pay the worktree cost.
export async function boardWorkspaceProvisionPOST(req: Request, res: Response): Promise<void> {
  try {
    const parsed = provisionWorkspaceBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const result = await provisionTaskWorkspace(taskId, parsed.data)
    if (!result.ok) {
      if (result.reason === 'not_found') {
        res.status(404).json({ ok: false, error: 'task not found' })
        return
      }
      if (result.reason === 'unsafe_to_rebuild') {
        res.status(409).json({
          ok: false,
          error: 'unsafe_to_rebuild',
          worktreePath: result.worktreePath,
          message: `Refusing to replace ${result.worktreePath}: ${result.why}.`,
        })
        return
      }
      res.status(422).json({ ok: false, error: 'no_isolation', isolation: result.isolation })
      return
    }
    res.json({
      ok: true,
      worktree: result.worktree,
      workspaceId: result.workspaceId,
      isolation: result.isolation,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/board/:taskId/workspace ────────────────────────────────────────
// The cold-resume read: the workspace row + the resume state reconstructed
// purely from the worktree's system-of-record (no chat, no board UI).
export async function boardWorkspaceGET(req: Request, res: Response): Promise<void> {
  try {
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const view = await getTaskWorkspace(taskId)
    if (!view.ok) {
      res.status(404).json({ error: 'workspace not found' })
      return
    }
    res.json({ ok: true, workspace: view.workspace, resume: view.resume, handoff: view.handoff })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/board/:taskId/workspace/handoff ───────────────────────────────
// Write the clock-out AGENT_HANDOFF.json (structured, not prose). `timestamp`
// is defaulted server-side when omitted.
export async function boardWorkspaceHandoffPOST(req: Request, res: Response): Promise<void> {
  try {
    const body: Record<string, unknown> =
      req.body && typeof req.body === 'object' ? { ...(req.body as Record<string, unknown>) } : {}
    if (!body['timestamp']) body['timestamp'] = new Date().toISOString()
    const parsed = agentHandoffSchema.safeParse(body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid handoff', details: parsed.error.flatten() })
      return
    }
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const result = await writeTaskHandoff(taskId, parsed.data)
    if (!result.ok) {
      res.status(404).json({ ok: false, error: 'workspace not found' })
      return
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── PATCH /api/board/:taskId/workspace ──────────────────────────────────────
// `pause` (commit + drop worktree + keep branch) or `complete` (empty diff →
// done + cleanup; non-empty → in_review + retain).
export async function boardWorkspaceActionPATCH(req: Request, res: Response): Promise<void> {
  try {
    const parsed = workspaceActionBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    // `complete` moves the card, and on an empty diff past a failing check, so it
    // takes a person's request here. A run's own completion does not come this way.
    // `pause` moves no card.
    if (parsed.data.action === 'complete' && refuseUnlessPerson(req, res)) return
    const db = getDb()
    const before = getTask(db, taskId)
    const result = await actOnTaskWorkspace(taskId, parsed.data.action)
    if (!result.ok) {
      res.status(404).json({ ok: false, error: 'workspace not found' })
      return
    }
    // On the event log with who asked. A move to Blocked writes its own event.
    const to = getTask(db, taskId)?.status
    if (before && to && to !== before.status && to !== 'blocked') {
      emitEvent(db, {
        kind: 'status_changed',
        taskId,
        teamId: before.teamId,
        data: { to, reason: 'workspace_complete', ...actorField(req) },
      })
    }
    // `result` already carries `ok: true` + the action outcome.
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/board/:taskId/executions ───────────────────────────────────────
// The run ledger for a task (any executor): tokens, cost, status, timestamps.
export function boardExecutionsGET(req: Request, res: Response): void {
  try {
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const executions = listExecutions(getDb(), taskId)
    res.json({ ok: true, executions })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/board/:taskId/workspace/detail ─────────────────────────────────
// The task-detail drawer's Workspace tab: SoR file contents + the unified diff
// (baseline vs working tree, SoR bookkeeping excluded). Most tasks never get a
// worktree, and the drawer asks on every open, so a known task without one is
// an ordinary answer (`ok: false`), not a 404; only an unknown task is.
export async function boardWorkspaceDetailGET(req: Request, res: Response): Promise<void> {
  try {
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const detail = await readWorktreeDetail(taskId)
    if (!detail.ok) {
      if (!getTask(getDb(), taskId)) {
        res.status(404).json({ error: 'task not found' })
        return
      }
      res.json({ ok: false, reason: 'no_workspace' })
      return
    }
    res.json(detail)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── Workspace filesystem view (agent-detail Workspace tab) ──────────────────
// Read-only. Paths resolve from the stored workspaces row and are confined to
// the worktree root by lib/workspaceFs; a refused path answers 400 with the
// refusal message, and a paused/reaped checkout answers 404 with reason 'gone'
// so the client can say "paused, branch retained" instead of "missing".

function sendWorkspaceMiss(res: Response, reason: WorkspaceMissReason): void {
  // `unreadable` is a real, distinct state: the checkout is on disk but git
  // refuses it. It answers 409 rather than 404 so a client cannot mistake it
  // for "no workspace" and render a clean tree.
  const status = reason === 'unreadable' ? 409 : 404
  const error = reason === 'unreadable' ? 'workspace unreadable' : 'workspace not found'
  res.status(status).json({ ok: false, error, reason })
}

function relParam(req: Request, name: string): string {
  const v = req.query[name]
  return typeof v === 'string' ? v : ''
}

// ─── GET /api/board/:taskId/workspace/tree?dir=<rel> ─────────────────────────
// One directory level (lazy tree). `dir` omitted or '' lists the root.
export async function boardWorkspaceTreeGET(req: Request, res: Response): Promise<void> {
  try {
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const result = await listWorkspaceDir(taskId, relParam(req, 'dir'))
    if (!result.ok) {
      sendWorkspaceMiss(res, result.reason)
      return
    }
    res.json(result)
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      res.status(400).json({ ok: false, error: err.message })
      return
    }
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/board/:taskId/workspace/file?path=<rel> ────────────────────────
// Bounded read-only file content. Binary files answer { binary: true } with no
// bytes; oversized text is truncated with a flag.
export async function boardWorkspaceFileGET(req: Request, res: Response): Promise<void> {
  try {
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const result = await readWorkspaceFile(taskId, relParam(req, 'path'))
    if (!result.ok) {
      sendWorkspaceMiss(res, result.reason)
      return
    }
    res.json(result)
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      res.status(400).json({ ok: false, error: err.message })
      return
    }
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/board/:taskId/preview/* ────────────────────────────────────────
// Serve the artifact the agent built, straight out of the task worktree, so the
// task drawer can iframe the actual rendered page beside the diff that produced
// it. Static files only — clawboo never runs an agent-authored build command.
//
// Mounted under /api on purpose: it inherits the origin guard and the access
// gate, and stays same-origin with the dashboard, so the gate's host-only
// SameSite=Lax cookie is actually sent. A `{port}.localhost` proxy origin would
// receive no cookie at all and 401 on every asset.
//
// Same-origin is also what makes agent-written script dangerous here: a page that
// ran it would act with the dashboard's own authority. The drawer's iframe is
// sandboxed, but its "Open" link, or anyone pasting the URL, loads the page top
// level, where an iframe attribute does nothing. So every response carries the
// iframe's exact sandbox as a CSP, which a browser applies to a top-level page
// too: no script runs, stylesheets and images still load. `allow-same-origin`
// stays, because an opaque origin makes the page's own asset requests
// cross-site, and the origin guard refuses every one of them. Never
// `allow-scripts`: next to `allow-same-origin` it hands the page the dashboard's
// authority again.
export const PREVIEW_CSP = 'sandbox allow-same-origin'

export async function boardWorkspacePreviewGET(req: Request, res: Response): Promise<void> {
  // First, so the redirect and the error replies carry it as well.
  res.setHeader('Content-Security-Policy', PREVIEW_CSP)
  try {
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    // Everything after `/preview/`. A `*splat` route gives the segments as an
    // array (or a string when there is exactly one); the bare route gives none.
    const splat = (req.params as Record<string, unknown>)['splat']
    const rel = (Array.isArray(splat) ? splat.join('/') : String(splat ?? ''))
      .split('/')
      .map((seg) => {
        try {
          return decodeURIComponent(seg)
        } catch {
          // A malformed escape is a bad path, not a 500 — let the containment
          // check reject the raw segment.
          return seg
        }
      })
      .join('/')
    const found = await resolvePreviewFile(taskId, rel)
    if (!found.ok) {
      res.status(found.status).json({ ok: false, error: found.error })
      return
    }
    // A directory index MUST be served from a URL ending in `/`. Without it the
    // page's own relative hrefs resolve one level too high — `src/app.css` on
    // `…/preview` becomes `…/<taskId>/src/app.css` — and the artifact renders
    // unstyled, which reads as a broken preview rather than a broken URL.
    if (found.isIndex && !req.path.endsWith('/')) {
      // Built from PARSED, root-relative parts. `req.originalUrl` is the raw
      // request target, and HTTP/1.1 absolute-form (`GET http://evil.com/x`) puts
      // someone else's origin into it, so redirecting to it makes this an open
      // redirect. `req.baseUrl` and `req.path` are parsed by Express and can only
      // ever be root-relative. The base path is re-added because the middleware
      // strips it from `req.url` before routing, and a subpath install would
      // otherwise be sent to the unprefixed URL and 404.
      const base = typeof req.app.locals['basePath'] === 'string' ? req.app.locals['basePath'] : ''
      const q = req.url.indexOf('?')
      const search = q === -1 ? '' : req.url.slice(q)
      res.redirect(302, `${base}${req.baseUrl}${req.path}/${search}`)
      return
    }
    // Opened before any header is set, so a refused open answers as an error.
    const opened = await openPreviewStream(found)
    if (!opened.ok) {
      res.status(opened.status).json({ ok: false, error: opened.error })
      return
    }
    res.setHeader('Content-Type', found.contentType)
    res.setHeader('Content-Length', String(opened.size))
    // A worktree changes under a running agent, so a cached asset would show a
    // stale build seconds after the fix landed.
    res.setHeader('Cache-Control', 'no-store')
    // Belt and braces on top of the content-type allowlist: never let a
    // previewed file be re-sniffed into something executable.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const { stream } = opened
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'preview read failed' })
      else res.end()
    })
    // A client that leaves mid-stream would otherwise keep the file open.
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  } catch (err) {
    log.error({ err }, 'serving a preview file failed')
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/board/:taskId/workspace/status ─────────────────────────────────
// `git status --porcelain` for the worktree, parsed to {path, x, y} entries.
// Drives the tree's change badges and the diffstat chips.
export async function boardWorkspaceStatusGET(req: Request, res: Response): Promise<void> {
  try {
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const result = await workspaceGitStatus(taskId)
    if (!result.ok) {
      sendWorkspaceMiss(res, result.reason)
      return
    }
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/board/:taskId/workspace/file-diff?path=<rel> ───────────────────
// Unified diff for ONE file against the task's baseline commit. Empty for an
// untracked file; the client falls back to the content view.
export async function boardWorkspaceFileDiffGET(req: Request, res: Response): Promise<void> {
  try {
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const result = await workspaceFileDiff(taskId, relParam(req, 'path'))
    if (!result.ok) {
      sendWorkspaceMiss(res, result.reason)
      return
    }
    res.json(result)
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      res.status(400).json({ ok: false, error: err.message })
      return
    }
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/agents/:agentId/workspaces ─────────────────────────────────────
// The task workspaces belonging to one agent's assigned tasks, newest first.
// `onDisk: false` marks a paused/reaped checkout (row + branch survive). The
// Workspace tab uses this to pick what to show and to render an honest empty
// state when the agent has no local workspace at all. `teamFolder` is the folder
// the agent starts in when it has no worktree (team chat, read-only tasks), or
// null for a runtime that gets none (OpenClaw).
export function agentWorkspacesGET(req: Request, res: Response): void {
  try {
    const agentId = (req.params['agentId'] as string | undefined) ?? ''
    const db = getDb()
    const tasks = listTasks(db).filter((t) => t.assigneeAgentId === agentId && t.worktreeRef)
    const workspaces = tasks.flatMap((t) => {
      const ws = getWorkspaceForTask(db, t.id)
      if (!ws || !ws.worktreePath || ws.status === 'archived') return []
      return [
        {
          taskId: t.id,
          title: t.title,
          taskStatus: t.status,
          branch: ws.branch,
          repoPath: ws.repoPath,
          worktreePath: ws.worktreePath,
          workspaceStatus: ws.status,
          onDisk: existsSync(ws.worktreePath),
          updatedAt: t.updatedAt,
        },
      ]
    })
    res.json({ ok: true, workspaces, teamFolder: agentTeamFolder(agentId) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/agents/:agentId/team-folder/tree?dir=<rel> ─────────────────────
// One directory level of the agent's team folder. Read-only, and the root comes
// from the agent's row, never the request.
export async function agentTeamFolderTreeGET(req: Request, res: Response): Promise<void> {
  try {
    const agentId = (req.params['agentId'] as string | undefined) ?? ''
    const result = await listTeamFolderDir(agentId, relParam(req, 'dir'))
    if (!result.ok) {
      sendWorkspaceMiss(res, result.reason)
      return
    }
    res.json(result)
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      res.status(400).json({ ok: false, error: err.message })
      return
    }
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/agents/:agentId/team-folder/file?path=<rel> ────────────────────
// Bounded read-only file content from the agent's team folder, same shape as
// the task workspace file route.
export async function agentTeamFolderFileGET(req: Request, res: Response): Promise<void> {
  try {
    const agentId = (req.params['agentId'] as string | undefined) ?? ''
    const result = await readTeamFolderFile(agentId, relParam(req, 'path'))
    if (!result.ok) {
      sendWorkspaceMiss(res, result.reason)
      return
    }
    res.json(result)
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      res.status(400).json({ ok: false, error: err.message })
      return
    }
    res.status(500).json({ error: String(err) })
  }
}
