// ─── Board zod schemas ──────────────────────────────────────────────────────
// Used for (a) REST request-body validation in apps/web/server/api/board.ts and
// (b) validating raw recursive-CTE results at runtime (clawboo rule: never trust
// TS generics over raw-SQL output).

import { RUN_COST_SOURCES, TASK_STATUSES, type TaskStatus } from '@clawboo/board-core'
import { z } from 'zod'

// Cast to a non-empty tuple of TaskStatus so `z.infer` yields the union (not
// `string`) — callers get a typed status without re-casting.
export const taskStatusSchema = z.enum([...TASK_STATUSES] as [TaskStatus, ...TaskStatus[]])

export const createTaskBody = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(20_000).optional(),
  status: taskStatusSchema.optional(),
  priority: z.number().int().optional(),
  // Scope tags reject '' (a truthy/empty-string mix-up is the scope-escape
  // class): a task is either scoped to a real team/tenant or has none.
  teamId: z.string().min(1).optional(),
  assigneeRuntime: z.string().optional(),
  parentTaskId: z.string().optional(),
  sourceDelegationId: z.string().optional(),
  tenantId: z.string().min(1).optional(),
  // Create the task FOR one agent on `teamId` (the board's New task dialog). The
  // server binds it to that agent and starts it; see POST /api/board.
  assigneeAgentId: z.string().min(1).optional(),
})
export type CreateTaskBody = z.infer<typeof createTaskBody>

export const updateTaskBody = z
  .object({
    status: taskStatusSchema.optional(),
    priority: z.number().int().optional(),
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(20_000).optional(),
    // Explicit, audited bypass of the intrinsic `→done` verification gate (a
    // human deciding to ship despite a non-promotable verdict). Only meaningful
    // alongside `status: 'done'`; the route records the override in the audit log.
    humanOverride: z.boolean().optional(),
    // When a move to done or cancelled finished, if not now (epoch ms): a person
    // marking work done on the day it was really done. Only meaningful with one of
    // those two statuses; the repository checks it falls between the task's
    // creation and now.
    completedAt: z.number().int().positive().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field required' })
  .refine((b) => b.completedAt === undefined || b.status === 'done' || b.status === 'cancelled', {
    message: 'completedAt goes with a move to done or cancelled',
    path: ['completedAt'],
  })
export type UpdateTaskBody = z.infer<typeof updateTaskBody>

export const claimBody = z.object({
  assigneeAgentId: z.string().min(1),
  assigneeRuntime: z.string().optional(),
})
export type ClaimBody = z.infer<typeof claimBody>

export const commentBody = z.object({
  body: z.string().min(1).max(20_000),
  authorAgentId: z.string().optional(),
  authorType: z.enum(['agent', 'user', 'system']).default('agent'),
})
export type CommentBody = z.infer<typeof commentBody>

// Execution-ledger bodies. An exec row is created only after a successful claim
// (taskId comes from the URL, executorType identifies the runtime); it is later
// completed with an outcome + optional token/cost ledger.
export const createExecutionBody = z.object({
  executorType: z.string().min(1).max(100),
  workspaceId: z.string().optional(),
  runReason: z.string().max(2_000).optional(),
  beforeCommit: z.string().max(200).optional(),
})
export type CreateExecutionBody = z.infer<typeof createExecutionBody>

export const completeExecutionBody = z
  .object({
    status: z.enum(['succeeded', 'failed', 'timed_out', 'cancelled']),
    summary: z.string().max(20_000).optional(),
    error: z.string().max(20_000).optional(),
    afterCommit: z.string().max(200).optional(),
    inputTokens: z.number().int().optional(),
    outputTokens: z.number().int().optional(),
    cacheRead: z.number().int().optional(),
    cacheWrite: z.number().int().optional(),
    costUsd: z.number().optional(),
    // No default: a cost sent without a source is stored with a null source, which
    // the board shows as an estimate.
    costSource: z.enum(RUN_COST_SOURCES).optional(),
  })
  .refine((b) => b.costSource !== 'local' || !b.costUsd, {
    // `local` means the run cost nothing (a model your own Ollama served); a
    // nonzero cost under it would read "free" on the board.
    message: "costSource 'local' is only for a cost of 0",
    path: ['costSource'],
  })
export type CompleteExecutionBody = z.infer<typeof completeExecutionBody>

// Dependency-link body — `taskId` waits on `dependsOnTaskId` before it becomes
// ready (a plan step depends on the prior step; a blocked task on its blocker).
export const linkDepBody = z.object({
  dependsOnTaskId: z.string().min(1),
})
export type LinkDepBody = z.infer<typeof linkDepBody>

// Worktree provisioning body. `repoPath` is the git repo the worktree branches
// from (the caller — a worktree-capable runtime — supplies it). `baseSha` pins
// the branch point; otherwise `baseRef` (default HEAD) is resolved. `kind`
// drives the isolation decision (only file-mutating work gets a worktree).
export const provisionWorkspaceBody = z.object({
  repoPath: z.string().min(1).max(4_000),
  baseSha: z.string().max(200).optional(),
  baseRef: z.string().max(400).optional(),
  kind: z.string().max(100).optional(),
})
export type ProvisionWorkspaceBody = z.infer<typeof provisionWorkspaceBody>

// Worktree action body — `pause` (commit + drop worktree, keep branch) or
// `complete` (empty diff → cleanup; non-empty → retain + flip task to in_review).
export const workspaceActionBody = z.object({
  action: z.enum(['pause', 'complete']),
})
export type WorkspaceActionBody = z.infer<typeof workspaceActionBody>

// Raw recursive-CTE row shape (snake_case, straight from SQLite). Validated with
// zod because the row is untyped at runtime.
export const ancestorRowSchema = z.object({
  id: z.string(),
  parent_task_id: z.string().nullable(),
  title: z.string(),
  status: z.string(),
})
export const ancestorRowsSchema = z.array(ancestorRowSchema)
export type AncestorRow = z.infer<typeof ancestorRowSchema>
