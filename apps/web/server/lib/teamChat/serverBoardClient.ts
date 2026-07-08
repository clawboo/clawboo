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
  completeExecutionProcess,
  createExecutionProcess,
  createTask,
  getAncestors,
  getComments,
  getReadyTasks,
  getTask,
  linkDep,
  listTasks,
  updateStatus,
  type ClawbooDb,
  type TaskStatus,
} from '@clawboo/db'
import type {
  BoardClient,
  BoardTask,
  ClaimResult,
  CompleteExecutionOutcome,
  CreateTaskInput,
  ExecutionRef,
  TaskDetail,
} from '@clawboo/team-orchestration'

import { emitEvent } from '../obs'

/**
 * Build a `BoardClient` over a held SQLite handle + a team scope. The engine
 * calls it the same way it calls the browser's REST client; every method
 * resolves to the engine's expected null/false/empty on failure (never throws),
 * and a claim conflict surfaces as `{ ok: false, reason: 'conflict' }` (never
 * retried).
 */
export function createServerBoardClient(db: ClawbooDb): BoardClient {
  return {
    async createTask(input: CreateTaskInput): Promise<BoardTask | null> {
      try {
        const task = createTask(db, input)
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

    async claim(taskId, assigneeAgentId, assigneeRuntime): Promise<ClaimResult> {
      try {
        const result = claimTask(db, taskId, assigneeAgentId, assigneeRuntime)
        if (result.ok && result.task) {
          const t = result.task
          emitEvent(db, {
            kind: 'task_claimed',
            taskId: t.id,
            teamId: t.teamId,
            agentId: t.assigneeAgentId,
            runtime: t.assigneeRuntime,
            data: { assigneeAgentId: t.assigneeAgentId, assigneeRuntime: t.assigneeRuntime },
          })
        }
        return result as ClaimResult
      } catch {
        return { ok: false, reason: 'error' }
      }
    },

    async updateStatus(taskId, status): Promise<boolean> {
      try {
        // Route through the repo's state-machine-enforced `updateStatus`: a
        // `→todo` clears the assignee + verification (re-claimable), and an
        // illegal/verification-gated transition returns `{ ok: false }` → false,
        // which the engine must NOT retry.
        const result = updateStatus(db, taskId, status as TaskStatus)
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

    async addComment(taskId, body, authorType = 'system', authorAgentId): Promise<void> {
      try {
        addComment(db, taskId, body, authorType, authorAgentId ?? null)
        emitEvent(db, {
          kind: 'comment_added',
          taskId,
          agentId: authorAgentId ?? null,
          data: { authorType, body },
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
          ancestors: getAncestors(db, taskId).map((a) => ({ id: a.id })),
        }
      } catch {
        return null
      }
    },

    async createExecution(taskId, executorType): Promise<ExecutionRef | null> {
      try {
        const execution = createExecutionProcess(db, {
          taskId,
          executorType,
          runReason: 'team-orchestration',
        })
        const task = getTask(db, taskId)
        emitEvent(db, {
          kind: 'execution_started',
          taskId,
          teamId: task?.teamId ?? null,
          agentId: task?.assigneeAgentId ?? null,
          runtime: execution.executorType,
          data: { execId: execution.id, executorType: execution.executorType },
        })
        return { id: execution.id }
      } catch {
        return null
      }
    },

    async completeExecution(execId, outcome: CompleteExecutionOutcome): Promise<void> {
      try {
        completeExecutionProcess(db, execId, outcome)
        emitEvent(db, {
          kind: 'execution_completed',
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
        return getReadyTasks(db, { teamId }) as BoardTask[]
      } catch {
        return []
      }
    },

    async listTasks(teamId): Promise<BoardTask[]> {
      try {
        return listTasks(db, { teamId }) as BoardTask[]
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
