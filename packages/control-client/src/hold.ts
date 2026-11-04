// Drain and hold: `GET`, `POST /api/system/hold` and `DELETE /api/system/hold/:owner`.
// Something about to stop or restart the engine (a stop command, an updater, a
// process manager) places a hold, so no new agent run starts, and waits until
// `backgroundWork` is `none` before it stops. A hold lapses after its time to
// live unless its owner places it again, and only its owner releases it. Check
// the `system.hold` capability flag first: an engine without it has no hold.

import { z } from 'zod'

export const engineHoldSchema = z.object({
  /** The id its holder chose; the only id that releases it. */
  owner: z.string().min(1),
  /** What the holder said it is doing, or null. */
  reason: z.string().nullable(),
  /** Epoch ms, on the engine's clock. */
  heldAt: z.number(),
  /** Epoch ms when it lapses unless renewed. */
  expiresAt: z.number(),
  /** `expiresAt` minus the engine's clock when it answered. */
  expiresInMs: z.number(),
})
export type EngineHold = z.infer<typeof engineHoldSchema>

export const engineHoldStateSchema = z.object({
  /** True while any hold is live: no new agent run starts. */
  held: z.boolean(),
  holds: z.array(engineHoldSchema),
  /** `present` while an agent run is executing; `none` when a stop kills none. */
  backgroundWork: z.enum(['present', 'none']),
  runs: z.object({
    /** Agent runs executing now. */
    running: z.number().int().nonnegative(),
    /** Runs waiting to start; while held they do not start. */
    queued: z.number().int().nonnegative(),
    /** How many runs may execute at once. */
    limit: z.number().int().positive(),
  }),
})
export type EngineHoldState = z.infer<typeof engineHoldStateSchema>
