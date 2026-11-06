// The runs this process drives for board tasks outside the team engine, by
// task, so a person who moves a card can stop the run working on it. Two kinds
// register here: the executor runner (a routine fire on a native or coding
// agent, a direct runtime run) and the OpenClaw routine dispatcher. The team
// engine stops the runs it started itself (`personMovedTask`).
//
// A stop carries a note, which the run records on the task in place of its usual
// "Run aborted" comment, and which tells the run's caller the person's move is the
// outcome rather than a failure. A pause stops these runs too (`stopPausedTaskRuns`),
// and their ledger rows say so, because that task comes back on its own.

interface Entry {
  note: string | null
  byPause: boolean
  agentId: string | null
  /** Still in the run queue: a pause leaves it there, held by the queue's own check. */
  waiting: boolean
  onStop: () => void
  /** Told once when the run is over (see whenTaskRunsEnd). */
  onEnd: Array<() => void>
}

const byTask = new Map<string, Set<Entry>>()

export interface RunStopHandle {
  /** The person's note, once the run has been stopped; null until then. */
  readonly note: string | null
  /** The stop came from a pause, not from a person moving the card. */
  readonly byPause: boolean
  /** The run has its slot now: a pause stops it. */
  started(): void
  /** The run is over: forget it. */
  release(): void
}

/** Register a run working on `taskId` for `agentId`. `onStop` must end the run promptly. */
export function registerRunStop(
  taskId: string,
  onStop: () => void,
  agentId: string | null = null,
  opts: { waiting?: boolean } = {},
): RunStopHandle {
  const entry: Entry = {
    note: null,
    byPause: false,
    agentId,
    waiting: opts.waiting ?? false,
    onStop,
    onEnd: [],
  }
  const set = byTask.get(taskId) ?? new Set<Entry>()
  set.add(entry)
  byTask.set(taskId, set)
  return {
    get note() {
      return entry.note
    },
    get byPause() {
      return entry.byPause
    },
    started() {
      entry.waiting = false
    },
    release() {
      set.delete(entry)
      if (set.size === 0 && byTask.get(taskId) === set) byTask.delete(taskId)
      for (const fn of entry.onEnd.splice(0)) fn()
    },
  }
}

/** Stop every registered run working on `taskId`, because a person moved its
 *  card. False when none is. */
export function stopTaskRuns(taskId: string, note: string): boolean {
  const set = byTask.get(taskId)
  if (!set || set.size === 0) return false
  for (const entry of set) {
    if (entry.note !== null) continue
    entry.note = note
    try {
      entry.onStop()
    } catch {
      // The run's own watchdog still ends it.
    }
  }
  return true
}

/** Call `fn` once every run now registered on `taskId` is over: at once if none is. */
export function whenTaskRunsEnd(taskId: string, fn: () => void): void {
  const entries = [...(byTask.get(taskId) ?? [])]
  let left = entries.length
  if (left === 0) return fn()
  for (const entry of entries) {
    entry.onEnd.push(() => {
      left -= 1
      if (left === 0) fn()
    })
  }
}

/** Stop every registered run a pause covers, except one still waiting for a run slot:
 *  it has claimed nothing, and it starts in its place on resume. The tasks it stopped. */
export function stopPausedTaskRuns(
  covers: (run: { agentId: string | null; taskId: string }) => boolean,
  note: string,
): string[] {
  const stopped: string[] = []
  for (const [taskId, set] of [...byTask]) {
    for (const entry of set) {
      if (entry.note !== null || entry.waiting) continue
      if (!covers({ agentId: entry.agentId, taskId })) continue
      entry.note = note
      entry.byPause = true
      try {
        entry.onStop()
      } catch {
        // The run's own watchdog still ends it.
      }
      stopped.push(taskId)
    }
  }
  return stopped
}
