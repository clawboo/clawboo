// Drain and hold: `clawboo stop`, an in-app update or a process manager asks the
// engine to stop starting new work, waits for the agent runs already going to
// finish, and only then stops or restarts it, so no run is killed halfway.
//
// A hold belongs to an owner id its caller picks. While any hold is live no new
// agent run starts: the run slots (see runSlots) grant none, so every run start
// (a board task, a team chat delivery, a one-to-one chat turn, a peer-exchange
// turn, an OpenClaw Routine) waits in their queue exactly as it waits behind a
// full cap; the Routines ticker claims no due routine; and the board's dispatch
// pump skips its pass. Runs already executing are never touched. They finish and
// give their slots back. Runs inside an OpenClaw Gateway that this server did not
// start (a 1:1 chat the dashboard sends to the Gateway, the Gateway's own cron
// jobs) are outside the hold, and a stop does not kill them either.
//
// Every hold has a time to live, so a holder that crashed cannot freeze the
// engine: a holder renews by placing its hold again before it lapses, and only
// the owner id that placed a hold can release it. When the last hold lifts, by
// release or by lapse, the engine resumes: the queue hands its waiting runs their
// slots, the ticker rescans and the pump runs a pass.
//
// The time to live is wall-clock time, unlike the engine's run limits, which
// leave laptop sleep out: a holder that slept too renews when it wakes, and one
// that never wakes has crashed.
//
// Holds live in memory. A restart drops them, which is what a stop or an update
// is waiting for anyway.

import { createLogger } from '@clawboo/logger'

const log = createLogger('engine-hold')

/** A hold's time to live when its owner names none. */
export const HOLD_TTL_DEFAULT_MS = 60_000
/** The shortest time to live a hold may ask for. */
export const HOLD_TTL_MIN_MS = 5_000
/** The longest: a crashed holder freezes new work for at most this long. */
export const HOLD_TTL_MAX_MS = 15 * 60_000

/** An owner id: what a holder names itself, and the only key that releases its hold. */
export const HOLD_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/
/** The owner id of the in-app update's own hold. Reserved: no client places or releases it. */
export const SELF_UPDATE_HOLD_OWNER = 'self-update'
/** The longest reason a holder may give. */
export const HOLD_REASON_MAX = 200

export interface EngineHold {
  owner: string
  /** What the holder said it is doing (`stop`, `update`, …); null when it said nothing. */
  reason: string | null
  /** Epoch ms when this owner placed it. A renewal keeps it. */
  heldAt: number
  /** Epoch ms when it lapses unless its owner renews it. */
  expiresAt: number
}

export interface PlaceHoldOptions {
  /** Clamped to [HOLD_TTL_MIN_MS, HOLD_TTL_MAX_MS]. Defaults to HOLD_TTL_DEFAULT_MS. */
  ttlMs?: number
  /** Kept as given on a renewal that names none. */
  reason?: string | null
}

export interface EngineHolds {
  /** Place `owner`'s hold, or renew it: `ttlMs` from now either way. */
  place(owner: string, opts?: PlaceHoldOptions): EngineHold
  /** Lift `owner`'s hold. False when that owner holds none; no other owner's hold is touched. */
  release(owner: string): boolean
  /** Whether any hold is live now. */
  isHeld(): boolean
  /** The live holds, oldest first. */
  list(): EngineHold[]
  /** Call `fn` each time the last live hold lifts, by release or by lapse. Returns an unsubscribe. */
  onResume(fn: () => void): () => void
}

export function clampHoldTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined || !Number.isFinite(ttlMs)) return HOLD_TTL_DEFAULT_MS
  return Math.min(HOLD_TTL_MAX_MS, Math.max(HOLD_TTL_MIN_MS, Math.round(ttlMs)))
}

export function createEngineHolds(deps: { now?: () => number } = {}): EngineHolds {
  const now = deps.now ?? ((): number => Date.now())
  const holds = new Map<string, EngineHold>()
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | null = null

  // Listeners run on a microtask, never inside the call that noticed the lift:
  // `isHeld` is read from inside the run slots' own grant path, and a resume
  // listener re-enters it.
  const resumeSoon = (): void => {
    queueMicrotask(() => {
      if (holds.size > 0) return // held again before the listeners ran
      for (const fn of [...listeners]) {
        try {
          fn()
        } catch (err) {
          log.error({ err }, 'a resume listener threw after the engine hold lifted')
        }
      }
    })
  }

  /** Drop lapsed holds; resume when that empties the map. */
  const prune = (): void => {
    if (holds.size === 0) return
    const at = now()
    let lapsed = false
    for (const [owner, hold] of holds) {
      if (hold.expiresAt > at) continue
      holds.delete(owner)
      lapsed = true
      log.warn(
        { owner, reason: hold.reason },
        'engine hold lapsed without being released; new agent runs may start again',
      )
    }
    if (lapsed && holds.size === 0) resumeSoon()
  }

  /** One timer, at the earliest expiry, so a lapse resumes the engine without a reader. */
  const arm = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (holds.size === 0) return
    let earliest = Infinity
    for (const hold of holds.values()) earliest = Math.min(earliest, hold.expiresAt)
    timer = setTimeout(
      () => {
        timer = null
        prune()
        arm()
      },
      Math.max(0, earliest - now()),
    )
    timer.unref?.()
  }

  return {
    place(owner, opts = {}) {
      prune()
      const at = now()
      const ttlMs = clampHoldTtl(opts.ttlMs)
      const existing = holds.get(owner)
      const hold: EngineHold = {
        owner,
        reason: opts.reason !== undefined ? opts.reason : (existing?.reason ?? null),
        heldAt: existing?.heldAt ?? at,
        expiresAt: at + ttlMs,
      }
      holds.set(owner, hold)
      if (!existing) {
        log.info(
          { owner, reason: hold.reason, ttlMs, holders: holds.size },
          'engine held: no new agent run starts until every hold is released',
        )
      }
      arm()
      return { ...hold }
    },
    release(owner) {
      prune()
      if (!holds.delete(owner)) return false
      log.info({ owner, holders: holds.size }, 'engine hold released')
      arm()
      if (holds.size === 0) resumeSoon()
      return true
    },
    isHeld() {
      prune()
      return holds.size > 0
    },
    list() {
      prune()
      return [...holds.values()].sort((a, b) => a.heldAt - b.heldAt).map((h) => ({ ...h }))
    },
    onResume(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

let shared: EngineHolds | null = null

/**
 * The process's holds. One instance for the life of the process, so the run
 * slots, the Routines ticker and the dispatch pump all subscribe to the same one.
 */
export function engineHold(): EngineHolds {
  if (!shared) shared = createEngineHolds()
  return shared
}

/** Whether the process's engine is held now. */
export function engineHeld(): boolean {
  return engineHold().isHeld()
}
