// For hosts that sleep and wake the engine: `GET /api/system/idle` and
// `POST /api/system/presence`. Whatever stops an idle engine and starts it again
// on demand (a process supervisor, a desktop shell, a service manager) reads one
// answer: is a person here, is work going, and when is the next scheduled work
// due, so it can wake the engine just before. A client a person uses reports them
// with a presence beat; reading never counts as presence. Check the `system.idle`
// capability flag first: an engine without it has neither route.

import { z } from 'zod'

/** A time on the engine's clock, epoch ms. */
const epochMs = z.number().int().nonnegative()

export const idlePeopleSchema = z.object({
  /** A visible, focused tab beat or a person acted within the last minute, or a
   *  person holds an agent's screen (Take over) now. */
  present: z.boolean(),
  /** The latest focused-tab beat or action; null when none since the engine started. */
  lastSeenAt: epochMs.nullable(),
  /** The latest action a client reported; null when none since the engine started. */
  lastActedAt: epochMs.nullable(),
  /** Tabs whose latest beat said visible and focused. */
  focusedTabs: z.number().int().nonnegative(),
})
export type IdlePeople = z.infer<typeof idlePeopleSchema>

export const idleWorkSchema = z.object({
  /** `present` while an agent run executes or a work check is under way; `none`
   *  when stopping now cuts none short. The same answer as GET /api/system/hold. */
  backgroundWork: z.enum(['present', 'none']),
  runs: z.object({
    running: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  }),
  /** Team-chat work checks under way or waiting for the team folder. */
  checks: z.number().int().nonnegative(),
  /** Routine fires under way (claimed, or dispatched and not finished). */
  routinesInFlight: z.number().int().nonnegative(),
  /** True while a hold is placed: no new agent run starts. */
  held: z.boolean(),
})
export type IdleWork = z.infer<typeof idleWorkSchema>

/**
 * One schedule source. `ok`: read now. `off`: not in use (nothing set up, or its
 * jobs run somewhere this engine's sleep does not stop), so it has nothing due.
 * `unknown`: in use but not readable now; `at` is then the earliest next run it
 * reported before, if one is still ahead, and the true earliest may be sooner.
 */
export const idleDueSourceSchema = z.object({
  id: z.string().min(1),
  state: z.enum(['ok', 'off', 'unknown']),
  /** Its earliest next run; at or before the answer's `at` means due now. */
  at: epochMs.nullable(),
  /** Schedules with a next run. */
  count: z.number().int().nonnegative(),
  /** The IANA zone its earliest time was worked out in, when the source says;
   *  null for a fixed interval or time, or when the source leaves it to its own system. */
  timeZone: z.string().min(1).nullable(),
  /** Why it is `off` or `unknown`. */
  reason: z.string().optional(),
})
export type IdleDueSource = z.infer<typeof idleDueSourceSchema>

export const idleNextDueSchema = z.object({
  /** The earliest next run across every source that named one; null when none did. */
  at: epochMs.nullable(),
  /** False when a source is `unknown`: something may be due sooner than `at`. */
  complete: z.boolean(),
  /** The IANA zone the engine's own routines are worked out in. */
  timeZone: z.string().min(1),
  sources: z.array(idleDueSourceSchema),
})
export type IdleNextDue = z.infer<typeof idleNextDueSchema>

export const engineIdleStateSchema = z.object({
  /** The engine's clock when it answered, epoch ms. */
  at: epochMs,
  people: idlePeopleSchema,
  work: idleWorkSchema,
  nextDue: idleNextDueSchema,
})
export type EngineIdleState = z.infer<typeof engineIdleStateSchema>

/** `POST /api/system/presence`: one client's beat. */
export const presenceBeatSchema = z.object({
  /** The client's own id for its tab or window, 1 to 64 of A-Z a-z 0-9 _ -. */
  tabId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  visible: z.boolean(),
  focused: z.boolean(),
  /** The person did something since the client's last beat. */
  acted: z.boolean().optional(),
})
export type PresenceBeatInput = z.infer<typeof presenceBeatSchema>
