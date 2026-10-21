// The runs this process drives for board tasks outside the team engine, by
// task, so a person who moves a card can stop the run working on it. Two kinds
// register here: the executor runner (a routine fire on a native or coding
// agent, a direct runtime run) and the OpenClaw routine dispatcher. The team
// engine stops the runs it started itself (`personMovedTask`).
//
// A stop carries a note, which the run records on the task in place of its usual
// "Run aborted" comment, and which tells the run's caller the person's move is the
// outcome rather than a failure.

interface Entry {
  note: string | null
  onStop: () => void
}

const byTask = new Map<string, Set<Entry>>()

export interface RunStopHandle {
  /** The person's note, once the run has been stopped; null until then. */
  readonly note: string | null
  /** The run is over: forget it. */
  release(): void
}

/** Register a run working on `taskId`. `onStop` must end the run promptly. */
export function registerRunStop(taskId: string, onStop: () => void): RunStopHandle {
  const entry: Entry = { note: null, onStop }
  const set = byTask.get(taskId) ?? new Set<Entry>()
  set.add(entry)
  byTask.set(taskId, set)
  return {
    get note() {
      return entry.note
    },
    release() {
      set.delete(entry)
      if (set.size === 0 && byTask.get(taskId) === set) byTask.delete(taskId)
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
