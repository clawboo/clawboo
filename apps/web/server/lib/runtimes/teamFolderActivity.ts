// Who is working in a team folder right now, in this process, so a team-chat work
// check can wait until a teammate has finished changing it (see teamWorkCheck).
//
// The folder is shared across a team's rooms and with its task runs, while an
// engine instance is per room, so this lives beside the folder rather than in any
// engine, and every run that starts in the folder reports here. Clawboo cannot see
// inside a run, so "working in the folder" means a run on a runtime that starts
// there, from just before its start to its end. A run that only reads the folder
// counts too. An OpenClaw agent works in its Gateway's own workspace, and a task
// run with a worktree in its own checkout, so neither reports here. A run still
// waiting for a run slot or its agent's lock has not started, so it does not count.
//
// Runs never wait for anything here: a run reports and goes. Only checks wait. They
// take turns, first come first served, each until no run is going and no other
// check is running. A check waits only on runs and on a check already running,
// neither of which can be waiting on it, so two checks cannot hold each other up.

/** One run working in a folder. `release` may be called any number of times. */
export interface FolderRun {
  release(): void
}

/** A check's place in a folder's line. */
export interface FolderCheckTurn {
  /** It may run now: the folder is clear and nothing is ahead of it. */
  readonly clear: boolean
  /** Resolves once the turn comes, or at once when `signal` aborts, and the check
   *  then runs beside whatever is still going. */
  wait(signal: AbortSignal): Promise<void>
  /** A run has been going in the folder at some point since the check began. */
  sawRun(): boolean
  /** Leave the line, or end the running check. May be called any number of times. */
  leave(): void
}

interface Turn {
  grant: (() => void) | null
  sawRun: boolean
}

interface FolderState {
  /** The agent of each run going now, one entry per run. */
  runs: string[]
  /** Checks running now. */
  checks: Set<Turn>
  /** Checks waiting, oldest first. */
  line: Turn[]
}

const folders = new Map<string, FolderState>()

function stateOf(folder: string): FolderState {
  let state = folders.get(folder)
  if (!state) {
    state = { runs: [], checks: new Set(), line: [] }
    folders.set(folder, state)
  }
  return state
}

/** Move the next check up if the folder has cleared, and forget an idle folder. */
function settle(folder: string, state: FolderState): void {
  if (state.runs.length === 0 && state.checks.size === 0) {
    const next = state.line.shift()
    if (next) {
      state.checks.add(next)
      next.grant?.()
      next.grant = null
    }
  }
  if (state.runs.length === 0 && state.checks.size === 0 && state.line.length === 0)
    folders.delete(folder)
}

/** Report a run working in `folder`, until `release`. */
export function startFolderRun(folder: string, agentId: string): FolderRun {
  const state = stateOf(folder)
  state.runs.push(agentId)
  for (const turn of state.checks) turn.sawRun = true
  let going = true
  return {
    release(): void {
      if (!going) return
      going = false
      state.runs.splice(state.runs.indexOf(agentId), 1)
      settle(folder, state)
    },
  }
}

/** The agents of the runs going in `folder` now, without repeats. */
export function folderRunners(folder: string): string[] {
  return [...new Set(folders.get(folder)?.runs ?? [])]
}

/** Take a place in the folder's line of checks. It runs at once when nothing is
 *  going and no check is ahead of it. Whoever enters must `leave`. */
export function enterFolderCheckLine(folder: string): FolderCheckTurn {
  const state = stateOf(folder)
  const turn: Turn = { grant: null, sawRun: false }
  state.line.push(turn)
  settle(folder, state)
  const clear = state.checks.has(turn)
  let left = false
  return {
    clear,
    wait(signal) {
      return new Promise<void>((resolve) => {
        if (state.checks.has(turn)) return resolve()
        const skipTheLine = (): void => {
          const at = state.line.indexOf(turn)
          if (at === -1) return // its turn came first
          state.line.splice(at, 1)
          state.checks.add(turn)
          turn.sawRun = state.runs.length > 0
          turn.grant = null
          resolve()
        }
        if (signal.aborted) return skipTheLine()
        signal.addEventListener('abort', skipTheLine, { once: true })
        turn.grant = () => {
          signal.removeEventListener('abort', skipTheLine)
          resolve()
        }
      })
    },
    sawRun: () => turn.sawRun,
    leave(): void {
      if (left) return
      left = true
      const at = state.line.indexOf(turn)
      if (at !== -1) state.line.splice(at, 1)
      state.checks.delete(turn)
      settle(folder, state)
    },
  }
}
