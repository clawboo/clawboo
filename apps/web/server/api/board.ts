// ─── Durable board REST ─────────────────────────────────────
// Thin HTTP layer over @clawboo/db's board repository (the data boundary — no
// raw Drizzle here). Bodies are validated with the co-located zod schemas
// exported from @clawboo/db.

import type { Request, Response } from 'express'

import {
  addComment,
  appendAudit,
  claimBody,
  claimTask,
  commentBody,
  completeExecutionBody,
  cancelDependents,
  completeExecutionProcess,
  createDb,
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
  updateStatus,
  updateTaskBody,
  updateTaskFields,
  workspaceActionBody,
  type TaskStatus,
} from '@clawboo/db'
import { agentHandoffSchema } from '@clawboo/worktrees'

import { getDbPath } from '../lib/db'
import { emitEvent } from '../lib/obs'
import { reflectToRoom } from '../lib/teamChat/reflect'
import {
  actOnTaskWorkspace,
  getTaskWorkspace,
  provisionTaskWorkspace,
  readWorktreeDetail,
  writeTaskHandoff,
} from '../lib/worktrees'

// ─── GET /api/board ──────────────────────────────────────────────────────────
// Query: teamId?, status?, ready?=true (deps satisfied), includeDropped?=true
export function boardListGET(req: Request, res: Response): void {
  try {
    const db = createDb(getDbPath())
    const teamId = typeof req.query['teamId'] === 'string' ? req.query['teamId'] : undefined
    if (req.query['ready'] === 'true') {
      res.json({ tasks: getReadyTasks(db, teamId ? { teamId } : {}) })
      return
    }
    const status =
      typeof req.query['status'] === 'string' ? (req.query['status'] as TaskStatus) : undefined
    const includeDropped = req.query['includeDropped'] === 'true'
    res.json({ tasks: listTasks(db, { teamId, status, includeDropped }) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/board/:taskId ────────────────────────────────────────────────
// Returns the task plus its comments and ancestor chain.
export function boardGetGET(req: Request, res: Response): void {
  try {
    const db = createDb(getDbPath())
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const task = getTask(db, taskId)
    if (!task) {
      res.status(404).json({ error: 'task not found' })
      return
    }
    res.json({ task, comments: getComments(db, taskId), ancestors: getAncestors(db, taskId) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/board ───────────────────────────────────────────────────────
export function boardCreatePOST(req: Request, res: Response): void {
  try {
    const parsed = createTaskBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const db = createDb(getDbPath())
    const task = createTask(db, parsed.data)
    // Observability: emit self-gates → no-op when obs is off.
    emitEvent(db, {
      kind: 'task_created',
      taskId: task.id,
      teamId: task.teamId,
      data: { title: task.title, status: task.status, parentTaskId: task.parentTaskId },
    })
    res.json({ task })
  } catch (err) {
    res.status(500).json({ error: String(err) })
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
    const db = createDb(getDbPath())
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
          data: { assigneeAgentId: t.assigneeAgentId, assigneeRuntime: t.assigneeRuntime },
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
// metadata (priority / title / description).
export function boardUpdatePATCH(req: Request, res: Response): void {
  try {
    const parsed = updateTaskBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const db = createDb(getDbPath())
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const { status, humanOverride, ...fields } = parsed.data

    if (status) {
      // The verification gate is intrinsic to `updateStatus`; `humanOverride`
      // (a human shipping despite a non-promotable verdict) is the only bypass —
      // record it in the audit log so the override is never silent.
      const priorStatus = getTask(db, taskId)?.status ?? null
      const result = updateStatus(db, taskId, status, humanOverride ? { humanOverride: true } : {})
      if (!result.ok) {
        res
          .status(result.reason === 'not_found' ? 404 : 409)
          .json({ ok: false, error: result.reason })
        return
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
    const task = hasFields ? updateTaskFields(db, taskId, fields) : getTask(db, taskId)
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
        data: { to: status },
      })
      // Narrate the mutation into the team room (fan-out to N peers).
      // Best-effort, AFTER the canonical board write; never a write path back.
      reflectToRoom(db, task.teamId, `Task "${task.title}" → ${status}.`)
    }
    res.json({ ok: true, task })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/board/:taskId/comments ────────────────────────────────────────
export function boardCommentPOST(req: Request, res: Response): void {
  try {
    const parsed = commentBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const db = createDb(getDbPath())
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const comment = addComment(
      db,
      taskId,
      parsed.data.body,
      parsed.data.authorType,
      parsed.data.authorAgentId,
    )
    emitEvent(db, {
      kind: 'comment_added',
      taskId,
      agentId: parsed.data.authorAgentId ?? null,
      data: { authorType: parsed.data.authorType, body: parsed.data.body },
    })
    // Narrate the comment into the team room so every peer sees it, not just the
    // leader (best-effort, AFTER the canonical write; never a write path back).
    const task = getTask(db, taskId)
    if (task) {
      const author = parsed.data.authorAgentId ?? parsed.data.authorType
      reflectToRoom(
        db,
        task.teamId,
        `${author} on "${task.title}": ${parsed.data.body.slice(0, 160)}`,
      )
    }
    res.json({ ok: true, comment })
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
    const db = createDb(getDbPath())
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const task = getTask(db, taskId)
    if (!task) {
      res.status(404).json({ error: 'task not found' })
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
    const db = createDb(getDbPath())
    const execId = (req.params['execId'] as string | undefined) ?? ''
    completeExecutionProcess(db, execId, parsed.data)
    // taskId/agentId aren't in scope on this REST path (only execId) — the
    // execution_started event carries them; correlate by execId. The runner path
    // (T5) emits a fully-correlated execution_completed.
    emitEvent(db, {
      kind: 'execution_completed',
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
    const db = createDb(getDbPath())
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    // Guard against orphan dep rows: both endpoints of the edge must exist.
    const task = getTask(db, taskId)
    const dependsOn = getTask(db, parsed.data.dependsOnTaskId)
    if (!task || !dependsOn) {
      res.status(404).json({ error: 'task not found' })
      return
    }
    linkDep(db, taskId, parsed.data.dependsOnTaskId)
    emitEvent(db, {
      kind: 'dep_linked',
      taskId,
      data: { dependsOnTaskId: parsed.data.dependsOnTaskId },
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
    const db = createDb(getDbPath())
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
        data: { to: 'cancelled', reason: 'blocker_failed' },
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
    const result = await actOnTaskWorkspace(taskId, parsed.data.action)
    if (!result.ok) {
      res.status(404).json({ ok: false, error: 'workspace not found' })
      return
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
    const executions = listExecutions(createDb(getDbPath()), taskId)
    res.json({ ok: true, executions })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/board/:taskId/workspace/detail ─────────────────────────────────
// The task-detail drawer's Workspace tab: SoR file contents + the unified diff
// (baseline vs working tree, SoR bookkeeping excluded).
export async function boardWorkspaceDetailGET(req: Request, res: Response): Promise<void> {
  try {
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const detail = await readWorktreeDetail(taskId)
    if (!detail.ok) {
      res.status(404).json({ error: 'workspace not found' })
      return
    }
    res.json(detail)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
