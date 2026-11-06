// Who wants to know a pause was lifted: the run slots, the Routines ticker and the
// dispatch pump, the same three that follow the engine hold. A pause lives in the
// database (see @clawboo/db's board/pauses), and this is only the nudge that
// nothing has to poll for. A restart loses no pause, and its boot pass reads them.

import type { StartRefusal } from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import { DeliveryRefusedError } from '@clawboo/team-orchestration'

const log = createLogger('pause-bus')

const listeners = new Set<() => void>()

/** Call `fn` each time a pause lifts. Returns an unsubscribe. */
export function onPauseLifted(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** A pause lifted (or a team came out of the archive): let waiting work start. On a
 *  microtask, as the engine hold does, so a listener never runs inside its caller. */
export function notifyPauseLifted(): void {
  queueMicrotask(() => {
    for (const fn of [...listeners]) {
      try {
        fn()
      } catch (err) {
        log.error({ err }, 'a listener threw after a pause lifted')
      }
    }
  })
}

const SCOPE_WORDS: Record<StartRefusal['kind'], { what: string; resume: string }> = {
  agent: { what: 'This agent is paused', resume: 'Resume it' },
  team: { what: 'This team is paused', resume: 'Resume the team' },
  task_tree: { what: 'This task tree is paused', resume: 'Resume the task tree' },
  archived_team: { what: 'This team is archived', resume: 'Bring the team back' },
}

/** What a person reads when something they asked for did not start. */
export function pauseRefusalText(refusal: StartRefusal): string {
  const { what, resume } = SCOPE_WORDS[refusal.kind]
  return `${what}, so this did not start. ${resume} to carry on.`
}

/** What a stopped run says: why, and no more. A turn with no task does not come back,
 *  and a routine's fire comes back as a new task, so neither can promise otherwise. */
export function pauseStopNote(refusal: StartRefusal): string {
  return `Stopped: ${SCOPE_WORDS[refusal.kind].what.toLowerCase()}.`
}

/** What a stopped task run in team chat says: its engine fires it again by itself. */
export function pauseTaskStopNote(refusal: StartRefusal): string {
  return refusal.kind === 'archived_team'
    ? `${pauseStopNote(refusal)} The task starts again if the team comes back.`
    : `${pauseStopNote(refusal)} The task starts again on resume.`
}

/** A person's or a routine's message refused because a pause covers its agent or
 *  team. Its reason is already in the chat. A routine keeps its schedule through it. */
export class PausedDeliveryError extends DeliveryRefusedError {}
