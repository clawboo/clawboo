// The durable-board surface the orchestration engine depends on, as an interface
// so each host injects its own implementation: the browser binds a `fetch`-based
// REST client (apps/web/src/lib/boardClient.ts), the server binds a direct-DB
// client over @clawboo/db (apps/web/server/lib/teamChat/serverBoardClient.ts),
// and the test suite injects a fake. Every method is defensive (network/parse/DB
// failures resolve to a null/false result, never throw) and 409-aware: a claim
// conflict means "someone else won" and MUST NOT be retried.

// The 7 canonical task statuses. Declared locally (not imported from @clawboo/db)
// so this host-agnostic interface package stays free of the server/db graph; it is
// structurally identical to @clawboo/db's `TaskStatus`, so a host binding over the
// direct-DB client still type-checks.
export type TaskStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled'

export interface CreateTaskInput {
  title: string
  description?: string
  /** Initial status; the server defaults to 'todo' when omitted. */
  status?: TaskStatus
  teamId?: string
  assigneeRuntime?: string
  parentTaskId?: string
  sourceDelegationId?: string
}

export interface BoardTask {
  id: string
  status: string
  title?: string
  description?: string | null
  teamId?: string | null
  assigneeAgentId?: string | null
  parentTaskId?: string | null
  createdAt?: number
  updatedAt?: number
  [k: string]: unknown
}

export type ClaimReason = 'conflict' | 'not_found' | 'error'
export interface ClaimResult {
  ok: boolean
  reason?: ClaimReason
  task?: BoardTask
}

export interface TaskDetail {
  task: BoardTask
  comments: unknown[]
  ancestors: { id: string }[]
}

export interface ExecutionRef {
  id: string
}

export interface CompleteExecutionOutcome {
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled'
  summary?: string
  error?: string
  costUsd?: number
}

/** The board surface the orchestrator needs. An interface so tests inject a fake. */
export interface BoardClient {
  createTask(input: CreateTaskInput): Promise<BoardTask | null>
  claim(taskId: string, assigneeAgentId: string, assigneeRuntime?: string): Promise<ClaimResult>
  updateStatus(taskId: string, status: string): Promise<boolean>
  addComment(
    taskId: string,
    body: string,
    authorType?: 'agent' | 'user' | 'system',
    authorAgentId?: string,
  ): Promise<void>
  getTask(taskId: string): Promise<TaskDetail | null>
  createExecution(taskId: string, executorType: string): Promise<ExecutionRef | null>
  completeExecution(execId: string, outcome: CompleteExecutionOutcome): Promise<void>
  /** Link a dependency: `taskId` waits on `dependsOnTaskId` (plans / blockedBy). */
  linkDep(taskId: string, dependsOnTaskId: string): Promise<boolean>
  /** Team tasks that are `todo` with all dependencies satisfied (fire-ready). */
  getReadyTasks(teamId: string): Promise<BoardTask[]>
  /** All non-dropped tasks for a team (the projection load). */
  listTasks(teamId: string): Promise<BoardTask[]>
  /**
   * Cancel the still-pending downstream chain of a FAILED task (its dependents
   * can never become ready). Returns the cancelled tasks so the orchestrator can
   * tell the leader the plan chain stalled.
   */
  cancelDependents(taskId: string): Promise<Array<{ id: string; title?: string }>>
}
