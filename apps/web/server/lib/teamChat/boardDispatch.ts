// A person asked for a board task to run: hand it to its team's orchestrator.
//
// Detached on purpose. Starting a run can wait a long time for an agent that is
// busy elsewhere (its home or connected-agent mutex is held by another run), and
// an HTTP request must not hang on that. The board reflects the outcome on its
// own: the card moves to In progress when the run starts, stays in To do while it
// waits for the agent, and lands in Needs you if the run fails.

import { createLogger } from '@clawboo/logger'

import { getTeamOrchestrator } from './teamOrchestrator'

const log = createLogger('board-dispatch')

export function requestTaskDispatch(
  teamId: string,
  taskId: string,
  mcpBaseUrl: string | null,
): void {
  getTeamOrchestrator(teamId, { mcpBaseUrl })
    .dispatchTask(taskId)
    .then((outcome) => log.debug({ teamId, taskId, outcome }, 'board task dispatch'))
    .catch((err: unknown) => log.error({ err, teamId, taskId }, 'board task dispatch failed'))
}
