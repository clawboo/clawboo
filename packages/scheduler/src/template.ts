// The bounded team-task spec a Routine materializes on each fire. Stored as
// JSON in scheduled_runs.task_template; validated at the registration boundary
// and re-validated by the wake-bridge before dispatch.

import { z } from 'zod'

export const taskTemplateSchema = z.object({
  /** Board task title for the materialized per-fire task. */
  title: z.string().min(1),
  description: z.string().nullish(),
  /** Worktree isolation kind (the board convention; 'code' provisions one). */
  kind: z.string().default('code'),
  priority: z.number().int().default(0),
  /** Repo the per-task worktree branches from (file-mutating fires). */
  repoPath: z.string().nullish(),
  model: z.string().nullish(),
  /** Per-node cost cap in cents, threaded into the executor run. */
  maxNodeCents: z.number().int().positive().nullish(),
  /**
   * Bind this Routine to an EXISTING team task instead of materializing a new
   * one per fire: the fire dispatches that task when it is claimable. This is
   * also where the one-TEAM-TASK-firing-owner guard bites at registration.
   */
  teamTaskId: z.string().nullish(),
})

export type TaskTemplate = z.infer<typeof taskTemplateSchema>

/** Parse + validate a task_template JSON string. Returns null when invalid. */
export function parseTaskTemplate(json: string): TaskTemplate | null {
  try {
    return taskTemplateSchema.parse(JSON.parse(json))
  } catch {
    return null
  }
}
