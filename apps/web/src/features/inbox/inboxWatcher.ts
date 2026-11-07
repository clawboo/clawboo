// Decides when the badge's read happens. It has no timer of its own: the app's one
// event tail wakes it, a burst of events becomes one read a moment later, and a
// quiet board reads nothing. A read that fails is tried again a few times, as the
// browser alerts do, so a quiet board still comes right.
//
// Reads run one at a time. A wake while one is out runs once more after it, because
// the read on the wire may have left before the change it was woken for.

export interface InboxWatcherDeps {
  /** Read the inbox and hold what it said. Resolves false when the read failed. */
  read(): Promise<boolean>
  /** How long after the first event of a burst the read waits for the rest. */
  batchMs: number
  /** When a read fails, read again after these waits, then wait for the next event. */
  retryMs: readonly number[]
}

export interface InboxWatcher {
  /** Something may have changed: read a moment from now. */
  poke(): void
  /** Read straight away (the app just opened). */
  readNow(): Promise<void>
  stop(): void
}

export function createInboxWatcher(deps: InboxWatcherDeps): InboxWatcher {
  let stopped = false
  let batch: ReturnType<typeof setTimeout> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let retries = 0
  let running: Promise<void> | null = null
  let queued = false

  const onRead = (ok: boolean): void => {
    if (ok) {
      if (retry !== null) clearTimeout(retry)
      retry = null
      retries = 0
      return
    }
    if (retry !== null || retries >= deps.retryMs.length) return
    const wait = deps.retryMs[retries]!
    retries += 1
    retry = setTimeout(() => {
      retry = null
      void run()
    }, wait)
  }

  const run = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (running) {
      queued = true
      return running
    }
    running = (async () => {
      try {
        let again = true
        while (again && !stopped) {
          queued = false
          const ok = await deps.read().catch(() => false)
          onRead(ok)
          again = queued
        }
      } finally {
        running = null
      }
    })()
    return running
  }

  return {
    poke() {
      // Throttled, not debounced: work that keeps moving tasks must not hold the
      // read off for as long as it keeps going.
      if (stopped || batch !== null) return
      batch = setTimeout(() => {
        batch = null
        // A new event starts the retries over.
        retries = 0
        void run()
      }, deps.batchMs)
    },
    readNow: run,
    stop() {
      stopped = true
      if (batch !== null) clearTimeout(batch)
      if (retry !== null) clearTimeout(retry)
      batch = null
      retry = null
      queued = false
    },
  }
}
