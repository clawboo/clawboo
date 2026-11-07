// A person asked for a board task to run: hand it to the orchestrator of the team
// chat room the task belongs to (the team's own group chat for most tasks).
//
// Detached on purpose. Starting a run can wait a long time for an agent that is
// busy elsewhere (its home or connected-agent mutex is held by another run), and
// an HTTP request must not hang on that. The board reflects the outcome on its
// own: the card moves to In progress when the run starts, stays in To do while it
// waits for the agent, and lands in Needs you if the run fails.

import { createLogger } from '@clawboo/logger'

import { engineHeld } from '../engineHold'
import { getTaskOrchestrator } from './teamOrchestrator'

const log = createLogger('board-dispatch')

export function requestTaskDispatch(
  teamId: string,
  taskId: string,
  mcpBaseUrl: string | null,
): void {
  getTaskOrchestrator(teamId, taskId, { mcpBaseUrl })
    .dispatchTask(taskId)
    .then((outcome) => log.debug({ teamId, taskId, outcome }, 'board task dispatch'))
    .catch((err: unknown) => log.error({ err, teamId, taskId }, 'board task dispatch failed'))
}

/** Have the room that owns this task send what its outbox holds, now rather than at its
 *  next sweep. A held engine starts nothing; its sweep sends it once the hold lifts. */
export function pumpRoomOfTask(teamId: string, taskId: string, mcpBaseUrl: string | null): void {
  if (engineHeld()) return
  getTaskOrchestrator(teamId, taskId, { mcpBaseUrl })
    .pump()
    .catch((err: unknown) => log.error({ err, teamId, taskId }, 'pumping the room failed'))
}
