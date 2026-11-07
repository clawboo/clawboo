// The SERVER binding of the orchestration engine's `BoardClient`: a direct-DB
// implementation over the @clawboo/db board repository (no HTTP — the server
// orchestrator runs in-process). It is the exact server-side mirror of the
// browser's `fetch` singleton (apps/web/src/lib/boardClient.ts): same method
// contract (never-throw / null / false / 409-never-retried) and the same obs
// `emitEvent` calls the REST handlers in `api/board.ts` emit, so the Board +
// Observability projections stay identical whether a team is browser- or
// server-orchestrated.
//
// Deliberate divergence from `api/board.ts`: it does NOT call `reflectToRoom`
// (the team_chat-room narration). For a server-orchestrated team the unified chat
// writer owns room/transcript narration (see persistTeamChatEntry); double-posting
// every board mutation into the room would be noise.

import {
  addComment,
  cancelDependents,
  claimTask,
  clearDelegationFailure,
  closeMainTask,
  closeWaitingHolderWhenOff,
  closeWaitingPlans,
  completeExecutionProcess,
  createCappedRootTask,
  createCappedSubtask,
  createExecutionProcess,
  createHandOffUnderRequest,
  createTask,
  deriveCreateKey,
  getAncestors,
  getComments,
  getReadyTasks,
  handOffCapacity,
  handOffChain,
  listExecutions,
  getTask,
  linkDep,
  listDirectDependentIds,
  listOpenMainTasks,
  listTasks,
  mainTaskState,
  parkMainTask,
  resumeMainTask,
  setTaskWaitingOn,
  markDelegationFailureNotified,
  noteDelegationFailure,
  planApprovalOn,
  proposePlan,
  readDelegationFailure,
  readResultClaim,
  releaseOneSubtaskWait,
  subtaskViewsOf,
  updateStatus,
  wakeCommentIds,
  type ClawbooDb,
  type DbTask,
  type TaskStatus,
} from '@clawboo/db'
import { delegationTargetOf, type TaskWakeReason } from '@clawboo/board-core'
import type {
  BoardTask,
  ClaimResult,
  CompleteExecutionOutcome,
  CreateTaskInput,
  EngineBoardClient,
  ExecutionRef,
  ExecutionSummary,
  HandOffInput,
  HandOffResult,
  TaskDetail,
} from '@clawboo/team-orchestration'

import { engineHeld } from '../engineHold'
import { emitEvent } from '../obs'
import { runsOnTaskRunner } from '../runnerRoute'

export interface ServerBoardClientOptions {
  /**
   * Bind the client to ONE chat room of the team: every task it creates belongs
   * to that room, and the engine's board reads (its projection load, ready pump
   * and resume) see only that room's tasks, so two rooms' engines never adopt
   * each other's work. `null` is the team's default room (the tasks with no
   * room). Omitted = no room scoping at all (tests, tools that read every room).
   */
  roomId?: string | null
}

/**
 * Build a `BoardClient` over a held SQLite handle + a team scope. The engine
 * calls it the same way it calls the browser's REST client; every method
 * resolves to the engine's expected null/false/empty on failure (never throws),
 * and a claim conflict surfaces as `{ ok: false, reason: 'conflict' }` (never
 * retried).
 */
export function createServerBoardClient(
  db: ClawbooDb,
  opts: ServerBoardClientOptions = {},
): EngineBoardClient {
  const scoped = 'roomId' in opts
  const roomId = opts.roomId ?? null
  return {
    async createTask(input: CreateTaskInput): Promise<BoardTask | null> {
      try {
        const task = createTask(db, scoped ? { ...input, roomId } : input)
        emitEvent(db, {
          kind: 'task_created',
          taskId: task.id,
          teamId: task.teamId,
          data: { title: task.title, status: task.status, parentTaskId: task.parentTaskId },
        })
        return task as BoardTask
      } catch {
        return null
      }
    },

    // A hand-off goes through the guarded creates, inside one write transaction: a
    // replay returns its task, the same words return the open one, and the caps the
    // Tasks tools answer to apply here too. The key is a derived one: if it ever meets
    // a blocked task or an old one, this is a new hand-off, not a replay.
    async createHandOff(input: HandOffInput): Promise<HandOffResult> {
      const { handOffKey, turnId, parentTaskId, mainTask, ...fields } = input
      try {
        const row = {
          ...(scoped ? { ...fields, roomId } : fields),
          agentCreated: true,
          titleMatchNeedsOwner: true,
          titleMatchExceptTurn: turnId ?? null,
          createKey: handOffKey ? deriveCreateKey(handOffKey.scope, handOffKey.text) : null,
        }
        const result =
          mainTask && !parentTaskId
            ? createHandOffUnderRequest(db, mainTask, row)
            : parentTaskId
              ? createCappedSubtask(db, parentTaskId, row)
              : createCappedRootTask(db, row, { teamId: fields.teamId ?? null })
        if (!result.ok) {
          return {
            ok: false,
            reason: result.reason,
            ...(result.count !== undefined ? { count: result.count } : {}),
            ...(result.max !== undefined ? { max: result.max } : {}),
            ...(result.windowMs !== undefined ? { windowMs: result.windowMs } : {}),
          }
        }
        const task = result.task
        if (task.deduplicated) {
          return { ok: true, task: task as BoardTask, deduplicated: task.deduplicatedBy ?? 'key' }
        }
        const madeMain = (result as { mainTask?: DbTask }).mainTask
        for (const made of madeMain ? [madeMain, task] : [task])
          emitEvent(db, {
            kind: 'task_created',
            taskId: made.id,
            teamId: made.teamId,
            data: { title: made.title, status: made.status, parentTaskId: made.parentTaskId },
          })
        return {
          ok: true,
          task: task as BoardTask,
          ...(madeMain ? { mainTask: madeMain as BoardTask } : {}),
        }
      } catch {
        return { ok: false, reason: 'error' }
      }
    },

    async handOffRoom(teamId, parentTaskId, opts) {
      try {
        return handOffCapacity(db, parentTaskId, teamId, opts)
      } catch {
        return null
      }
    },

    async mainTaskState(taskId) {
      try {
        return mainTaskState(db, taskId)
      } catch {
        return null
      }
    },

    async openMainTasks(teamId) {
      try {
        return listOpenMainTasks(db, scoped ? { teamId, roomId } : { teamId })
      } catch {
        return []
      }
    },

    async closeMainTask(taskId, to) {
      try {
        const closed = closeMainTask(db, taskId, to)
        if (closed)
          emitEvent(db, {
            kind: 'status_changed',
            taskId,
            teamId: getTask(db, taskId)?.teamId ?? null,
            data: { to, reason: 'request_closed' },
          })
        return closed
      } catch {
        return false
      }
    },

    async parkMainTask(taskId, need) {
      try {
        const parked = parkMainTask(db, taskId, need)
        // It now needs a person: what browser alerts follow.
        if (parked)
          emitEvent(db, {
            kind: 'status_changed',
            taskId,
            teamId: getTask(db, taskId)?.teamId ?? null,
            data: { to: 'blocked', reason: 'no_summary' },
          })
        return parked
      } catch {
        return false
      }
    },

    async resumeMainTask(taskId) {
      try {
        return resumeMainTask(db, taskId)
      } catch {
        return false
      }
    },

    async handOffChain(taskId) {
      try {
        return handOffChain(db, taskId)
      } catch {
        return null
      }
    },

    async delegationFailure(teamId, targetAgentId, taskKey) {
      try {
        return readDelegationFailure(db, teamId, targetAgentId, taskKey)
      } catch {
        return { failures: 0, notified: false }
      }
    },

    async noteDelegationFailure(teamId, targetAgentId, taskKey) {
      try {
        noteDelegationFailure(db, teamId, targetAgentId, taskKey)
      } catch {
        // best-effort: a breaker that missed one failure allows one more try
      }
    },

    async markDelegationFailureNotified(teamId, targetAgentId, taskKey) {
      try {
        markDelegationFailureNotified(db, teamId, targetAgentId, taskKey)
      } catch {
        // best-effort
      }
    },

    async clearDelegationFailure(teamId, targetAgentId, taskKey) {
      try {
        clearDelegationFailure(db, teamId, targetAgentId, taskKey)
      } catch {
        // best-effort
      }
    },

    async planApprovalOn(teamId) {
      try {
        return planApprovalOn(db, teamId)
      } catch {
        return false
      }
    },

    // The plan's question, its revision and the wait land in one write. What the alerts
    // follow is written with it, in the db layer, as for an agent's own `ask_person`.
    async proposePlan(input) {
      try {
        // The run's own task's latest run is that run. A turn with no task has none.
        const executionId = input.taskId
          ? (listExecutions(db, input.taskId).at(-1)?.id ?? null)
          : null
        const result = proposePlan(db, { ...input, executionId, ...(scoped ? { roomId } : {}) })
        if (result.status === 'off') return { status: 'off' }
        if (result.status === 'refused') return { status: 'refused', reason: result.reason }
        if (result.status !== 'proposed') return result
        if (result.mainTask)
          emitEvent(db, {
            kind: 'task_created',
            taskId: result.mainTask.id,
            teamId: result.mainTask.teamId,
            data: {
              title: result.mainTask.title,
              status: result.mainTask.status,
              parentTaskId: null,
            },
          })
        if (result.holderCreated)
          emitEvent(db, {
            kind: 'task_created',
            taskId: result.task.id,
            teamId: result.task.teamId,
            data: {
              title: result.task.title,
              status: result.task.status,
              parentTaskId: result.task.parentTaskId,
              actor: { kind: 'agent', agentId: input.agentId, execId: executionId },
            },
          })
        return {
          status: 'proposed',
          task: result.task as BoardTask,
          holder: result.task.id !== input.taskId,
          ...(result.mainTask ? { mainTask: result.mainTask as BoardTask } : {}),
          ...(result.replaced ? { replaced: { title: result.replaced.title } } : {}),
        }
      } catch {
        return { status: 'error' }
      }
    },

    async startingWithoutAsking(input) {
      try {
        closeWaitingHolderWhenOff(db, { ...input, ...(scoped ? { roomId } : {}) })
      } catch {
        // best-effort: a person can still turn it down
      }
    },

    async closeWaitingPlans(teamId) {
      try {
        closeWaitingPlans(db, { teamId, ...(scoped ? { roomId } : {}) })
      } catch {
        // best-effort: a person can still turn it down
      }
    },

    async claim(taskId, assigneeAgentId, assigneeRuntime, run): Promise<ClaimResult> {
      // A held engine (see engineHold) claims nothing: a claimed task would sit
      // `in_progress` waiting for a run slot across the stop the hold is for.
      // Refused as a conflict, the engine leaves the task in To do, as it does
      // when another engine wins the claim, and the server's dispatch pump fires
      // it once the hold lifts or after the next start. `claimTask` refuses a task a
      // pause covers the same way, whichever path asks.
      if (engineHeld()) return { ok: false, reason: 'conflict' }
      try {
        // The run opens with the claim, in one write: the execution, its stamp on the
        // task and the saved wakes it takes.
        const result = claimTask(
          db,
          taskId,
          assigneeAgentId,
          assigneeRuntime,
          run ? { run: { ...run, engineRun: true } } : {},
        )
        // A person's task is someone else's, as far as the engine goes: it leaves
        // it alone and moves on, as it does when another engine wins the claim.
        if (result.reason === 'person_assigned') return { ok: false, reason: 'conflict' }
        if (!result.ok || !result.task) return result as ClaimResult
        const t = result.task
        emitEvent(db, {
          kind: 'task_claimed',
          taskId: t.id,
          teamId: t.teamId,
          agentId: t.assigneeAgentId,
          runtime: t.assigneeRuntime,
          data: { assigneeAgentId: t.assigneeAgentId, assigneeRuntime: t.assigneeRuntime },
        })
        const execution = result.execution
        if (!execution) return result as ClaimResult
        emitEvent(db, {
          kind: 'execution_started',
          taskId,
          teamId: t.teamId,
          agentId: t.assigneeAgentId,
          runtime: execution.executorType,
          data: {
            execId: execution.id,
            executorType: execution.executorType,
            runReason: execution.runReason,
          },
        })
        return {
          ok: true,
          task: t as BoardTask,
          execution: { id: execution.id },
          wakes: (result.wakes ?? []).map((w) => ({
            id: w.id,
            reason: w.reason as TaskWakeReason,
            commentIds: wakeCommentIds(w),
          })),
        }
      } catch {
        return { ok: false, reason: 'error' }
      }
    },

    async updateStatus(taskId, status, opts): Promise<boolean> {
      try {
        // Route through the repo's state-machine-enforced `updateStatus`: a
        // `→todo` clears the assignee + verification (re-claimable), and an
        // illegal/verification-gated transition returns `{ ok: false }` → false,
        // which the engine must NOT retry.
        const result = updateStatus(db, taskId, status as TaskStatus, {
          ...(opts?.waitingOn ? { waitingOn: opts.waitingOn } : {}),
          ...(opts?.keepVerdict ? { keepVerdict: true } : {}),
        })
        if (result.ok && result.task) {
          const t = result.task
          emitEvent(db, {
            kind: 'status_changed',
            taskId,
            teamId: t.teamId,
            agentId: t.assigneeAgentId,
            data: { to: status },
          })
        }
        return result.ok
      } catch {
        return false
      }
    },

    async setWaitingOn(taskId, waitingOn): Promise<void> {
      setTaskWaitingOn(db, taskId, waitingOn)
      // It now needs a person without having moved: what browser alerts follow.
      const t = getTask(db, taskId)
      emitEvent(db, {
        kind: 'status_changed',
        taskId,
        teamId: t?.teamId ?? null,
        agentId: t?.assigneeAgentId ?? null,
        data: { to: t?.status ?? null, reason: 'waiting_on' },
      })
    },

    async addComment(taskId, body, authorType = 'system', authorAgentId): Promise<void> {
      try {
        // Clawboo's own note, or a run's result recorded by the engine. The engine
        // posts a run's report in its agent's name, around when it closes the run's
        // ledger row, so the task's latest run is that run.
        const execId =
          authorType === 'agent' ? (listExecutions(db, taskId).at(-1)?.id ?? null) : null
        addComment(db, taskId, body, authorType, authorAgentId ?? null, {
          kind: authorType === 'system' ? 'note' : authorType === 'agent' ? 'result' : null,
          executionId: execId,
        })
        emitEvent(db, {
          kind: 'comment_added',
          taskId,
          agentId: authorAgentId ?? null,
          data: {
            authorType,
            body,
            ...(authorType === 'agent' && authorAgentId
              ? { actor: { kind: 'agent', agentId: authorAgentId, execId } }
              : {}),
          },
        })
      } catch {
        // best-effort
      }
    },

    async getTask(taskId): Promise<TaskDetail | null> {
      try {
        const task = getTask(db, taskId)
        if (!task) return null
        return {
          task: task as BoardTask,
          comments: getComments(db, taskId),
          ancestors: getAncestors(db, taskId).map((a) => ({
            id: a.id,
            ...(a.is_main_task === 1 ? { isMainTask: true } : {}),
          })),
        }
      } catch {
        return null
      }
    },

    async createExecution(taskId, executorType, opts): Promise<ExecutionRef | null> {
      try {
        const execution = createExecutionProcess(db, {
          taskId,
          executorType,
          engineRun: true,
          runReason: opts?.runReason ?? null,
        })
        const task = getTask(db, taskId)
        emitEvent(db, {
          kind: 'execution_started',
          taskId,
          teamId: task?.teamId ?? null,
          agentId: task?.assigneeAgentId ?? null,
          runtime: execution.executorType,
          data: {
            execId: execution.id,
            executorType: execution.executorType,
            runReason: execution.runReason,
          },
        })
        return { id: execution.id }
      } catch {
        return null
      }
    },

    async completeExecution(execId, outcome: CompleteExecutionOutcome): Promise<void> {
      try {
        // Carry the same correlation columns `createExecution` puts on
        // `execution_started`. Without them `projectFleetHealth` drops the
        // completion (it skips any event with no `agentId`), so the open-run
        // counter never decrements and a finished agent reads working → stalled
        // → zombie forever; `projectGraph` likewise skips the authoritative
        // cost on `if (!taskId)`. `teamId` matters just as much: it is the
        // column the team-scoped dashboard read filters on, and SQL equality
        // never matches NULL, so an uncorrelated completion is invisible to the
        // Ghost Graph overlay even once the other two are populated.
        const exec = completeExecutionProcess(db, execId, outcome)
        // No row matched, so nothing was closed. Emitting anyway would append
        // exactly the uncorrelated event this block exists to prevent, for a run
        // that never ended.
        if (!exec) return
        const task = getTask(db, exec.taskId)
        emitEvent(db, {
          kind: 'execution_completed',
          taskId: exec.taskId,
          teamId: task?.teamId ?? null,
          // A hand-back takes the agent off the task before its run ends. The binding
          // still names it, or its open-run count would never come down.
          agentId: task?.assigneeAgentId ?? delegationTargetOf(task?.sourceDelegationId) ?? null,
          runtime: exec.executorType,
          data: {
            execId,
            status: outcome.status,
            costUsd: outcome.costUsd ?? null,
            error: outcome.error ?? null,
          },
        })
      } catch {
        // best-effort
      }
    },

    async linkDep(taskId, dependsOnTaskId): Promise<boolean> {
      try {
        linkDep(db, taskId, dependsOnTaskId)
        emitEvent(db, {
          kind: 'dep_linked',
          taskId,
          data: { dependsOnTaskId },
        })
        return true
      } catch {
        return false
      }
    },

    async getReadyTasks(teamId): Promise<BoardTask[]> {
      try {
        // A task the task runner ran, bound to an agent the runner can run, is
        // the runner's to fire (lib/runnerRerun): fired from here it would rerun
        // as a team-chat turn, with no worktree and no check.
        return getReadyTasks(db, scoped ? { teamId, roomId } : { teamId }).filter(
          (t) => !runsOnTaskRunner(db, t),
        ) as BoardTask[]
      } catch {
        return []
      }
    },

    async listExecutions(taskId): Promise<ExecutionSummary[] | null> {
      try {
        return listExecutions(db, taskId).map((e) => ({
          id: e.id,
          status: e.status,
          executorType: e.executorType,
          engineRun: e.engineRun,
          errorClass: e.errorClass,
          completedAt: e.completedAt,
          madeProgress: e.madeProgress,
          error: e.error,
          recoveryTombstone: e.recoveryTombstone,
          runReason: e.runReason,
          createdAt: e.createdAt,
        }))
      } catch {
        // NOT `[]` — see the interface note. An unreadable ledger must not read
        // as an empty one, or a transient sqlite error re-fires stopped work.
        return null
      }
    },

    async listTasks(teamId): Promise<BoardTask[]> {
      try {
        return listTasks(db, scoped ? { teamId, roomId } : { teamId }) as BoardTask[]
      } catch {
        return []
      }
    },

    async subtasksOf(taskId) {
      try {
        return subtaskViewsOf(db, taskId)
      } catch {
        return null
      }
    },
    async resultClaim(execId) {
      try {
        return readResultClaim(db, execId)
      } catch {
        return null
      }
    },
    async releaseSubtaskWait(taskId) {
      try {
        releaseOneSubtaskWait(db, taskId)
      } catch {
        // The pump's pass reads it again.
      }
    },
    async runsOnTaskRunner(taskId) {
      try {
        const task = getTask(db, taskId)
        return task ? runsOnTaskRunner(db, task) : false
      } catch {
        return true
      }
    },
    async directDependents(taskId): Promise<string[]> {
      try {
        return listDirectDependentIds(db, taskId)
      } catch {
        return []
      }
    },

    async cancelDependents(taskId): Promise<Array<{ id: string; title?: string }>> {
      try {
        const cancelled = cancelDependents(db, taskId)
        for (const t of cancelled) {
          emitEvent(db, {
            kind: 'status_changed',
            taskId: t.id,
            teamId: t.teamId,
            data: { to: 'cancelled', reason: 'blocker_failed' },
          })
        }
        return cancelled.map((t) => ({ id: t.id, title: t.title }))
      } catch {
        return []
      }
    },
  }
}
