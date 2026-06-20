// Non-destructive nudge queue (Gastown pattern). The board orchestration path
// has no other concurrency mutex, so this is the SOLE guard against starting a
// second run on a session that's already mid-turn: a message to a BUSY session
// is queued FIFO and delivered at the next turn boundary (the session's `done`),
// never interrupting an in-flight run.
//
// Two robustness guarantees beyond the basic queue:
//   • An IMMEDIATE send (idle session) PROPAGATES a rejection so the caller can
//     fail the task right away instead of waiting out the 8-min watchdog. The
//     session is un-busied on failure so it isn't wedged.
//   • A per-session WEDGE TIMEOUT force-idles a session whose turn boundary is
//     never observed (a dropped/lost `done` frame), so queued sends (e.g. a
//     `[Task Update]` to a busy leader) can't sit forever. Re-armed on every
//     `markBusy`, so an actively-streaming session never trips it.

export interface NudgeQueue {
  /**
   * Send now if the session is idle, else FIFO-enqueue for the next turn
   * boundary. `markBusy` is applied SYNCHRONOUSLY before awaiting `send` so a
   * second `deliver` in the same tick queues instead of double-sending. An
   * immediate send REJECTS to the caller on failure (the session is un-busied).
   */
  deliver(sessionKey: string, send: () => Promise<void>): Promise<void>
  /** Mark a session busy (call on any non-terminal event of a run). */
  markBusy(sessionKey: string): void
  /** Mark a session idle (its run ended) and flush one queued send if any. */
  markIdle(sessionKey: string): void
  /**
   * Fire every queued send once (fire-and-forget) then clear all state. Used on
   * teardown so a reflection queued for a still-busy session (e.g. a `[Task Update]`
   * to a mid-synthesis leader) is delivered before the adapter is disposed, rather
   * than silently dropped by `reset()`. The recipient's turn boundary may never
   * arrive post-teardown, so we flush proactively.
   */
  drain(): void
  reset(): void
}

/** Backstop: force-idle a session that never reports a turn boundary. Generous
 *  on purpose (re-armed on every `markBusy`; only TRUE silence trips it). */
const DEFAULT_WEDGE_TIMEOUT_MS = 10 * 60_000

export function createNudgeQueue(opts?: {
  wedgeTimeoutMs?: number
  /**
   * Called when a session's turn boundary is never observed and the wedge timer
   * is about to force-idle it. The caller should ABORT the (genuinely- or
   * apparently-) still-running session here, so the subsequent flush of a queued
   * send can't start a SECOND concurrent run on a session whose prior run is
   * actually still executing (a long silent tool-call is indistinguishable from a
   * lost `done` frame). Best-effort; the force-idle proceeds regardless.
   */
  onWedge?: (sessionKey: string) => void | Promise<void>
}): NudgeQueue {
  const wedgeMs = opts?.wedgeTimeoutMs ?? DEFAULT_WEDGE_TIMEOUT_MS
  const busy = new Set<string>()
  const queues = new Map<string, Array<() => Promise<void>>>()
  const wedgeTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const clearWedge = (sessionKey: string): void => {
    const t = wedgeTimers.get(sessionKey)
    if (t) {
      clearTimeout(t)
      wedgeTimers.delete(sessionKey)
    }
  }

  const armWedge = (sessionKey: string): void => {
    clearWedge(sessionKey)
    const t = setTimeout(() => {
      // The turn boundary was never observed — force-idle so queued sends aren't
      // wedged. (The orchestrator's own watchdog handles the task side.) First
      // abort any genuinely-still-running run so the flush below can't start a
      // SECOND concurrent run on this session.
      wedgeTimers.delete(sessionKey)
      void Promise.resolve(opts?.onWedge?.(sessionKey)).catch(() => undefined)
      markIdle(sessionKey)
    }, wedgeMs)
    if (typeof (t as { unref?: () => void }).unref === 'function')
      (t as { unref: () => void }).unref()
    wedgeTimers.set(sessionKey, t)
  }

  const flushOne = (sessionKey: string): void => {
    const q = queues.get(sessionKey)
    if (!q || q.length === 0) return
    const next = q.shift()!
    if (q.length === 0) queues.delete(sessionKey)
    // The queued send starts a new run, so the session is busy again until its
    // own `done` (which markIdle → flushes the next one). FIFO drain.
    busy.add(sessionKey)
    armWedge(sessionKey)
    void next().catch(() => undefined)
  }

  function markIdle(sessionKey: string): void {
    busy.delete(sessionKey)
    clearWedge(sessionKey)
    flushOne(sessionKey)
  }

  return {
    async deliver(sessionKey, send) {
      if (busy.has(sessionKey)) {
        const q = queues.get(sessionKey) ?? []
        q.push(send)
        queues.set(sessionKey, q)
        return
      }
      busy.add(sessionKey) // synchronous — closes the double-send race
      armWedge(sessionKey)
      try {
        await send()
      } catch (err) {
        // Immediate send failed (the agent never received it) — un-busy so the
        // session isn't wedged, and surface the failure to the caller.
        busy.delete(sessionKey)
        clearWedge(sessionKey)
        throw err
      }
    },
    markBusy(sessionKey) {
      busy.add(sessionKey)
      armWedge(sessionKey)
    },
    markIdle,
    drain() {
      // Fire every queued send once (fire-and-forget) before clearing — the
      // recipient's turn boundary may never arrive post-teardown, so a queued
      // reflection would otherwise be lost. Bounded: one batched send per queued
      // item, no re-entrancy (callers invoke this only at teardown).
      for (const t of wedgeTimers.values()) clearTimeout(t)
      wedgeTimers.clear()
      for (const q of queues.values()) {
        for (const send of q) void send().catch(() => undefined)
      }
      queues.clear()
      busy.clear()
    },
    reset() {
      for (const t of wedgeTimers.values()) clearTimeout(t)
      wedgeTimers.clear()
      busy.clear()
      queues.clear()
    },
  }
}
