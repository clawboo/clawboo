// Placing and lifting a person's pause, and what that does to work under way.
//
// PAUSING NEVER WAITS. The row is written first, and from that moment every start
// path refuses (see @clawboo/db's board/pauses for the check). There is no
// "pausing" state to get stuck in: the pause is on as soon as the write lands, and
// stopping the runs already going happens beside it, not before it. A run that
// ignores its abort is left to the watchdog that ends any silent run, and nothing
// about the pause depends on it.
//
// WHAT STOPS, within seconds, through the same Stop paths a person's move uses:
//   - a task run in team chat goes back to To do, its ledger row saying a pause
//     stopped it, and fires again on resume;
//   - a task runner run the same way, started again by the rerun pump;
//   - a routine's fire does not count as having happened: its row goes back to wait,
//     its card is set aside, and it runs again on resume as a new task (see
//     routines/wakeBridge), on the task runner and on OpenClaw alike;
//   - a lead's reply with no task is aborted, with the reason in the chat;
//   - a 1:1 chat turn (through this server) is aborted, with the reason in the chat;
//   - a peer exchange with a paused speaker ends;
//   - a task update or follow-up goes back to the outbox, and out again on resume.
// WHAT DOES NOT:
//   - a 1:1 chat with an OpenClaw agent runs in its Gateway, outside this server;
//   - a team-chat work check already running finishes its command: its run is over.
//     It starts no reviewer under the pause, and no fix round: the task waits in To
//     do with what the check found.
//
// A run waiting in the run queue that no person is watching (a task update, a task
// runner run or routine fire that has claimed nothing) stays there, skipped by the
// queue's own read of the pause, and starts on resume. A routine fire waiting there
// reads as running until then.

import {
  getTask,
  liftPause,
  pauseSubjectOfTask,
  placePause,
  subjectTeamId,
  taskTreeRootId,
  type ClawbooDb,
  type Pause,
  type PauseKind,
  type PauseSubject,
  type PersonRecord,
  type StartRefusal,
} from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import type { EventActor } from '@clawboo/obs'

import { stopPausedAgentChats } from './agentChat/driveAgentChat'
import { markReleasedTasksRead, runningTasksCovered } from './boardReader'
import { emitEvent } from './obs'
import { notifyPauseLifted, pauseStopNote, pauseTaskStopNote } from './pauseBus'
import { stopPausedTaskRuns, whenTaskRunsEnd } from './runStops'
import { stopPausedExchanges } from './teamChat/runTeamExchange'
import { stopPausedTeamRuns } from './teamChat/teamOrchestrator'

const log = createLogger('pause-runs')

/** Does this refusal cover a run? The same reading `pauseFor` gives, from one row. */
export function pauseCovers(db: ClawbooDb, refusal: StartRefusal): (run: PauseSubject) => boolean {
  switch (refusal.kind) {
    case 'agent':
      return (run) => run.agentId === refusal.id
    case 'team':
    case 'archived_team':
      return (run) => subjectTeamId(db, run) === refusal.id
    case 'task_tree':
      return (run) => !!run.taskId && taskTreeRootId(db, run.taskId) === refusal.id
  }
}

/**
 * Stop what a pause (or an archived team) covers. Never rejects, and its caller does
 * not wait for it: the pause holds whether or not a run has wound down yet. `reader`:
 * the person who asked, so the tasks this puts back in To do are not news to them.
 */
export async function stopPausedRuns(
  db: ClawbooDb,
  refusal: StartRefusal,
  reader: string | null = null,
): Promise<void> {
  const note = pauseStopNote(refusal)
  const notes = { task: pauseTaskStopNote(refusal), turn: note }
  const covers = pauseCovers(db, refusal)
  try {
    const running = reader
      ? runningTasksCovered(db, (task) => covers(pauseSubjectOfTask(task)))
      : []
    // The task says which team the run is for; the runner registers only its agent.
    const stopped = stopPausedTaskRuns(
      ({ agentId, taskId }) =>
        covers({ agentId, teamId: getTask(db, taskId)?.teamId ?? null, taskId }),
      note,
    )
    stopPausedExchanges(covers)
    // An agent stays reachable after its team is archived, so only a pause stops a 1:1.
    if (refusal.kind !== 'archived_team') await stopPausedAgentChats(db, covers, note)
    const stoppedInChat = await stopPausedTeamRuns(covers, notes)
    if (reader) {
      markReleasedTasksRead(db, reader, running)
      // The runner's run writes its own ending, once its abort has reached it.
      for (const id of stopped) {
        whenTaskRunsEnd(id, () => markReleasedTasksRead(db, reader, [id]))
      }
    }
    log.info(
      { kind: refusal.kind, id: refusal.id, runs: stopped.length + stoppedInChat.length },
      'stopped the runs a pause covers',
    )
  } catch (err) {
    log.error({ err, kind: refusal.kind, id: refusal.id }, 'stopping paused runs failed')
  }
}

/** What the event log names a pause by, so the activity feed can link it. */
function eventScope(
  kind: PauseKind,
  id: string,
): {
  agentId?: string
  teamId?: string
  taskId?: string
} {
  if (kind === 'agent') return { agentId: id }
  if (kind === 'team') return { teamId: id }
  return { taskId: id }
}

/** Who a pause's event says did it, as the route's person check found. */
interface PauseAuthor {
  actor?: EventActor
  person?: PersonRecord | null
}

/** Pause it, tell the event log, and stop its runs. A second pause changes nothing. */
export function pauseRuns(
  db: ClawbooDb,
  input: PauseAuthor & {
    kind: PauseKind
    id: string
    reason?: string | null
    /** Who to spare the news of the tasks this puts back: see stopPausedRuns. */
    reader?: string | null
  },
): { pause: Pause; created: boolean } {
  const placed = placePause(db, input)
  if (placed.created) {
    emitEvent(db, {
      kind: 'pause_placed',
      ...eventScope(input.kind, input.id),
      data: {
        scope: input.kind,
        id: input.id,
        reason: placed.pause.reason,
        ...(input.actor ? { actor: input.actor } : {}),
        ...(input.person ? { person: input.person } : {}),
      },
    })
  }
  // Again on a repeat too: a run may have started between the two.
  void stopPausedRuns(db, placed.pause, input.reader ?? null)
  return placed
}

/** Lift it and let waiting work start. False when it was not paused. */
export function resumeRuns(
  db: ClawbooDb,
  kind: PauseKind,
  id: string,
  who: PauseAuthor = {},
): boolean {
  if (!liftPause(db, kind, id)) return false
  emitEvent(db, {
    kind: 'pause_lifted',
    ...eventScope(kind, id),
    data: {
      scope: kind,
      id,
      ...(who.actor ? { actor: who.actor } : {}),
      ...(who.person ? { person: who.person } : {}),
    },
  })
  notifyPauseLifted()
  return true
}
