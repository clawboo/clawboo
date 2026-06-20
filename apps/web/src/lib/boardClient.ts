// Thin typed wrapper over the durable-board REST surface (apps/web/server/api/board.ts).
// Used by the event-driven orchestration path to turn lifecycle events into
// durable board mutations. Every method is defensive (network/parse failures
// resolve to a null/false result, never throw) and 409-aware: a claim conflict
// means "someone else won" and MUST NOT be retried.

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

export interface CreateTaskInput {
  title: string
  description?: string
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

export const boardClient: BoardClient = {
  async createTask(input) {
    try {
      const r = await fetch('/api/board', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      })
      if (!r.ok) return null
      const body = (await r.json()) as { task?: BoardTask }
      return body.task ?? null
    } catch {
      return null
    }
  },

  async claim(taskId, assigneeAgentId, assigneeRuntime) {
    try {
      const r = await fetch(`/api/board/${encodeURIComponent(taskId)}/claim`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ assigneeAgentId, assigneeRuntime }),
      })
      if (r.status === 409) return { ok: false, reason: 'conflict' }
      if (r.status === 404) return { ok: false, reason: 'not_found' }
      if (!r.ok) return { ok: false, reason: 'error' }
      const body = (await r.json()) as { task?: BoardTask }
      return { ok: true, task: body.task }
    } catch {
      return { ok: false, reason: 'error' }
    }
  },

  async updateStatus(taskId, status) {
    try {
      const r = await fetch(`/api/board/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ status }),
      })
      return r.ok
    } catch {
      return false
    }
  },

  async addComment(taskId, body, authorType = 'system', authorAgentId) {
    try {
      await fetch(`/api/board/${encodeURIComponent(taskId)}/comments`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ body, authorType, authorAgentId }),
      })
    } catch {
      // best-effort
    }
  },

  async getTask(taskId) {
    try {
      const r = await fetch(`/api/board/${encodeURIComponent(taskId)}`)
      if (!r.ok) return null
      return (await r.json()) as TaskDetail
    } catch {
      return null
    }
  },

  async createExecution(taskId, executorType) {
    try {
      const r = await fetch(`/api/board/${encodeURIComponent(taskId)}/executions`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ executorType }),
      })
      if (!r.ok) return null
      const body = (await r.json()) as { execution?: ExecutionRef }
      return body.execution ?? null
    } catch {
      return null
    }
  },

  async completeExecution(execId, outcome) {
    try {
      await fetch(`/api/board/executions/${encodeURIComponent(execId)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(outcome),
      })
    } catch {
      // best-effort
    }
  },

  async linkDep(taskId, dependsOnTaskId) {
    try {
      const r = await fetch(`/api/board/${encodeURIComponent(taskId)}/deps`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ dependsOnTaskId }),
      })
      return r.ok
    } catch {
      return false
    }
  },

  async getReadyTasks(teamId) {
    try {
      const r = await fetch(`/api/board?teamId=${encodeURIComponent(teamId)}&ready=true`)
      if (!r.ok) return []
      const body = (await r.json()) as { tasks?: BoardTask[] }
      return body.tasks ?? []
    } catch {
      return []
    }
  },

  async listTasks(teamId) {
    try {
      const r = await fetch(`/api/board?teamId=${encodeURIComponent(teamId)}`)
      if (!r.ok) return []
      const body = (await r.json()) as { tasks?: BoardTask[] }
      return body.tasks ?? []
    } catch {
      return []
    }
  },

  async cancelDependents(taskId) {
    try {
      const r = await fetch(`/api/board/${encodeURIComponent(taskId)}/cancel-dependents`, {
        method: 'POST',
        headers: JSON_HEADERS,
      })
      if (!r.ok) return []
      const body = (await r.json()) as { cancelled?: Array<{ id: string; title?: string }> }
      return body.cancelled ?? []
    } catch {
      return []
    }
  },
}

// ── Standalone read helpers for the Board dashboard (not on the orchestrator's
//    BoardClient interface, so its test fake is unaffected). ──────────────────

export interface BoardFetchResult {
  tasks: BoardTask[]
  /** False when the fetch FAILED (network / non-2xx) — lets the Board distinguish
   *  a fetch error from a genuinely empty board (both yield zero tasks). */
  ok: boolean
}

/** All non-dropped tasks + a success flag, scoped to a team (omit = all teams). */
export async function fetchBoardResult(teamId?: string): Promise<BoardFetchResult> {
  try {
    const url = teamId ? `/api/board?teamId=${encodeURIComponent(teamId)}` : '/api/board'
    const r = await fetch(url)
    if (!r.ok) return { tasks: [], ok: false }
    const body = (await r.json()) as { tasks?: BoardTask[] }
    return { tasks: body.tasks ?? [], ok: true }
  } catch {
    return { tasks: [], ok: false }
  }
}

/** All non-dropped tasks, optionally scoped to a team (omit teamId = all teams). */
export async function fetchBoardTasks(teamId?: string): Promise<BoardTask[]> {
  return (await fetchBoardResult(teamId)).tasks
}

export interface BoardExecution {
  id: string
  executorType?: string
  status?: string
  summary?: string | null
  error?: string | null
  costUsd?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  createdAt?: number
  completedAt?: number | null
  [k: string]: unknown
}

export async function getTaskExecutions(taskId: string): Promise<BoardExecution[]> {
  try {
    const r = await fetch(`/api/board/${encodeURIComponent(taskId)}/executions`)
    if (!r.ok) return []
    const body = (await r.json()) as { executions?: BoardExecution[] }
    return body.executions ?? []
  } catch {
    return []
  }
}

export interface DiffStat {
  filesChanged: number
  insertions: number
  deletions: number
  dirty: boolean
}

export interface WorkspaceDetail {
  ok: boolean
  workspace?: {
    repoPath?: string
    branch?: string | null
    worktreePath?: string | null
    status?: string
  }
  sorFiles?: Record<string, string>
  diffStat?: DiffStat | null
  diff?: string
}

export async function getWorkspaceDetail(taskId: string): Promise<WorkspaceDetail | null> {
  try {
    const r = await fetch(`/api/board/${encodeURIComponent(taskId)}/workspace/detail`)
    if (!r.ok) return null
    return (await r.json()) as WorkspaceDetail
  } catch {
    return null
  }
}
