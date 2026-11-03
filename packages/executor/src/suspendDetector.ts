// Watchdogs that survive the machine sleeping.
//
// A watchdog judges silence from wall-clock time, and wall-clock time keeps
// running while the machine sleeps. Node's timers do not help: on macOS libuv's
// clock counts the sleep too, so a long timer whose delay passed during the
// sleep fires the moment the machine wakes. Either way the watchdog fails work
// that was healthy when the lid closed. The process gets no signal that it was
// suspended other than a gap between two of its own ticks far longer than the
// interval it asked for, so both helpers here watch for that gap.
//
// The gap is all they see, so two cases come out wrong by design. A sleep no
// longer than two intervals is counted as awake time. And a process that was
// stalled while the machine stayed awake (a blocked event loop, a debugger, a
// stopped process) for longer than that is treated as asleep, so a watchdog
// fires late by about the stall.

/** A gap between two ticks longer than this many intervals means the process was
 *  suspended (the machine slept), not that one timer fired late. */
export const SUSPEND_GAP_FACTOR = 2

/**
 * Watch the ticks of a periodic watchdog that runs every `intervalMs`. Call the
 * returned function once per tick with the current time: it returns how long the
 * process was suspended since the previous tick, which the watchdog then leaves
 * off every clock it judges. An ordinary tick, even a late one, returns 0. Up to
 * one interval of a long gap may have been awake time before the suspension, so
 * that much still counts.
 *
 * `startAt` is the baseline for the first tick; without it the first tick only
 * records one. A non-positive interval detects nothing.
 */
export function createSuspendDetector(
  intervalMs: number,
  startAt?: number,
): (at: number) => number {
  if (!(intervalMs > 0)) return () => 0
  let last = startAt ?? null
  return (at) => {
    const prev = last
    last = at
    if (prev === null) return 0
    const gap = at - prev
    return gap > SUSPEND_GAP_FACTOR * intervalMs ? gap - intervalMs : 0
  }
}

/** How often an awake-time timer checks its deadline. */
export const AWAKE_TIMER_TICK_MS = 30_000

export interface AwakeTimer {
  clear(): void
}

/**
 * `setTimeout` for a watchdog: `fn` runs after `ms` of time the process was
 * awake. Instead of one long timer it checks every `AWAKE_TIMER_TICK_MS` and
 * moves its deadline past any suspension it sees, so a sleep does not fire it
 * on wake. A wait that a suspension cut into counts as asleep in full, since
 * the part before the sleep cannot be told from the rest: after a sleep `fn`
 * can run up to one tick late, never at the moment the machine wakes. The
 * timer never holds a Node process open.
 *
 * It reads the wall clock. A clock set back delays `fn` by the size of the
 * step. A clock set forward by up to one tick makes it that much early, and a
 * bigger jump is taken for a suspension.
 */
export function setAwakeTimeout(
  fn: () => void,
  ms: number,
  opts: { tickMs?: number; now?: () => number } = {},
): AwakeTimer {
  const now = opts.now ?? (() => Date.now())
  const tickMs = opts.tickMs ?? AWAKE_TIMER_TICK_MS
  // Without a positive tick the check would re-arm at once until the deadline,
  // and the suspend detector would be off.
  if (!(tickMs > 0)) throw new RangeError(`setAwakeTimeout: tickMs must be positive, got ${tickMs}`)
  const start = now()
  let deadline = start + ms
  /** When the last check ran, and how long the wait since then was meant to be. */
  let lastAt = start
  let waitMs = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (delay: number): void => {
    waitMs = Math.max(0, Math.min(delay, tickMs))
    timer = setTimeout(check, waitMs)
    // Under Node the handle is a Timeout carrying `unref`; the probe keeps this
    // browser-safe.
    const handle = timer as unknown as { unref?: () => void }
    if (typeof handle.unref === 'function') handle.unref()
  }
  const check = (): void => {
    const at = now()
    const gap = at - lastAt
    lastAt = at
    // More than a tick past what the wait asked for: the process was suspended
    // during it. Counting any of it as awake is what fired the timer on wake
    // when less than a tick of its allowance was left.
    if (gap > waitMs + tickMs) deadline += gap
    if (at < deadline) return schedule(deadline - at)
    timer = undefined
    fn()
  }
  schedule(ms)
  return {
    clear() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}
