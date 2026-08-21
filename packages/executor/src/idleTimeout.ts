// Idle guard for a run's event drain. The drain loops (`executorRunner`, the
// team orchestrator's `serverDeliver`) are bare `for await` consumers: an
// adapter iterator that hangs — a wedged provider call, a dead subprocess whose
// stdout never closes — used to hang its drain FOREVER, permanently holding the
// task claim, the agent's home-dispatch mutex, and (for a routine) the ticker.
// Wrapping the iterable here bounds that: silence past `idleMs` fires `onIdle`
// (the caller aborts the run there), then a short grace window lets the adapter
// surface its terminal `done`/`error` so the normal teardown path still runs;
// only if the iterator stays silent through the grace too does the stream end.
//
// The timer is IDLE-reset, not total: every event re-arms it, so a long but
// streaming run never trips. Distinct from the engine's 8-min delegate watchdog
// (which fails the TASK): this frees the PROCESS-side resources beneath it.

/** Default silence ceiling before a run's drain gives up on its iterator. High
 *  on purpose — an open tool call (build/test) is legitimately silent for many
 *  minutes; this catches the truly-wedged, not the slow. */
export const DEFAULT_RUN_SILENT_TIMEOUT_MS = 30 * 60_000

/** How long after `onIdle` (abort) the drain keeps listening for the adapter's
 *  own terminal before force-ending the stream. */
export const IDLE_ABORT_GRACE_MS = 5_000

export interface IdleTimeoutOpts {
  /** Silence ceiling between events. */
  idleMs: number
  /** Called once on the first idle expiry — abort the run here. */
  onIdle: () => void | Promise<void>
  /** Post-abort listening window for the adapter's terminal. Defaults to
   *  {@link IDLE_ABORT_GRACE_MS}. */
  graceMs?: number
}

/**
 * Re-yield `source`, bounding inter-event silence. On expiry: `onIdle()` fires
 * (caller aborts), then one grace window is granted for the adapter's terminal
 * event(s); a second expiry ends the stream. The caller's loop then falls
 * through to its normal no-terminal handling (`onSessionClosed` / error
 * terminal), so a silent-wedged run tears down through existing paths.
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  opts: IdleTimeoutOpts,
): AsyncGenerator<T, void, undefined> {
  const it = source[Symbol.asyncIterator]()
  let idled = false
  // The in-flight pull. CARRIED across an idle expiry: the race loser is a
  // still-pending `next()` that already owns the iterator's next value — issuing
  // a fresh pull instead would drop that value on the floor (exactly the
  // terminal the grace window exists to deliver).
  let pending: Promise<IteratorResult<T>> | null = null
  try {
    for (;;) {
      const windowMs = idled ? (opts.graceMs ?? IDLE_ABORT_GRACE_MS) : opts.idleMs
      let timer: ReturnType<typeof setTimeout> | undefined
      const expiry = new Promise<'idle'>((resolve) => {
        timer = setTimeout(() => resolve('idle'), windowMs)
        ;(timer as { unref?: () => void }).unref?.()
      })
      pending ??= it.next()
      const winner = await Promise.race([pending.then((r) => ({ r })), expiry])
      clearTimeout(timer)
      if (winner === 'idle') {
        if (idled) return // silent through the grace too — give up
        idled = true
        // Fire-and-forget: `onIdle` calls adapter.abort, which on a truly wedged
        // adapter can itself hang — awaiting it here would reintroduce the exact
        // unbounded wait this guard exists to remove. The grace timer bounds the
        // whole post-abort window regardless of whether the abort ever settles.
        void Promise.resolve()
          .then(() => opts.onIdle())
          .catch(() => undefined)
        continue // grace window: the pending pull stays armed for the terminal
      }
      pending = null
      if (winner.r.done) return
      yield winner.r.value
    }
  } finally {
    // End-of-consumption (including a caller break/throw): release the source.
    // `.catch` matters: a rejecting `return` implementation is otherwise a
    // floating rejection, the same class of defect as the carried pull above.
    void it.return?.(undefined)?.catch(() => undefined)
  }
}
