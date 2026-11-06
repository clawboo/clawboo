// The drawer's line for a saved wake that has not reached its agent yet: what it is
// waiting for, in words a person can act on. The server sends `pendingWake` on a
// task's detail (GET /api/board/:taskId); the reasons are board-core's
// `WakeSkipReason`.

export interface PendingWake {
  reason: string
  /** Why the pump last left it waiting. Null before a pass has seen it. */
  skipReason: string | null
  comments: number
  /** A person's Stop holds it: it starts no run and rides the task's next one. */
  held: boolean
}

/** Read the field off a task detail, or null when it is absent or malformed. */
export function readPendingWake(value: unknown): PendingWake | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v['reason'] !== 'string') return null
  return {
    reason: v['reason'],
    skipReason: typeof v['skipReason'] === 'string' ? v['skipReason'] : null,
    comments: typeof v['comments'] === 'number' ? v['comments'] : 0,
    held: v['held'] === true,
  }
}

export function pendingWakeText(wake: PendingWake, name: string): string {
  const what = wake.comments > 1 ? `${wake.comments} comments` : 'this'
  if (wake.held) return `Held by a Stop: ${name} reads ${what} on the task's next run`
  switch (wake.skipReason) {
    case 'held':
      return `Clawboo is holding new runs. ${name} reads ${what} when they resume`
    case 'budget':
      return `Waiting: a budget cap would refuse the run. Raise it to send ${what} to ${name}`
    case 'braked':
      return `Waiting a few minutes: the last runs made no visible progress. A comment from you starts it now`
    case 'agent_busy':
      return `${name} is busy with other work and reads ${what} next`
    case 'run_live':
      return `${name}'s run takes ${what} at its next turn`
    case 'run_unproven':
      return `The run on this task stopped answering. ${name} reads ${what} once it is cleared`
    case 'no_run':
      return `Nothing is running this task. Move it to To do to send ${what} to ${name}`
    case 'under_check':
      return `${name} reads ${what} after the check`
    case 'dependency':
      return `${name} reads ${what} when the task it waits on is done`
    case 'parked':
      return `This task failed too often to start by itself. Retry it to send ${what} to ${name}`
    case 'stopped':
      return `This task was stopped. Retry it to send ${what} to ${name}`
    case 'sign_in':
      return `Waiting on the runtime's sign-in. Fix it, then retry`
    case 'billing':
      return `Waiting on the provider's billing. Fix it, then retry`
    case 'blocked':
      return `Waiting on you: Retry starts ${name} on it`
    case 'person_assigned':
      return `This task is with a person. ${name} reads ${what} when it is given back`
    case 'question':
      return `${name} reads ${what} when its question is answered`
    case 'backlog':
      return `In Backlog. Move it to To do to send ${what} to ${name}`
    case 'no_agent':
      return `No agent has this task. Assign one to send ${what}`
    case 'room_archived':
    case 'no_team':
      return `Its chat is gone, so nothing can run this task`
    default:
      return `On its way to ${name}`
  }
}
