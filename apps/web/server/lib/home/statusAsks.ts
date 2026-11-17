// The lead-written status line, for teams that turned it on (off by default; it
// costs model calls). Every 15 minutes this looks at those teams and, for each
// whose board moved since its last line, at most once every 6 hours and 4 times a
// day (`takeLeadStatusAsk`), posts a short ask into the team chat for the lead.
// The ask shows in the chat as "Routine · Home status line", so a person can see
// what the lead was asked and what it cost. The lead answers with the Tasks tool
// `write_home_summary`, which keeps to the same limits.

import { takeLeadStatusAsk, teams, teamsWithLeadStatus, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'

import { getDb } from '../db'
import { engineHeld } from '../engineHold'
import { resolveServerOrchestrated } from '../teamChat/resolveServerOrchestrated'
import {
  getTeamOrchestrator,
  type EnqueueUserMessageInput,
  type EnqueueUserMessageResult,
} from '../teamChat/teamOrchestrator'

export const STATUS_ASK_INTERVAL_MS = 15 * 60 * 1000
export const STATUS_ASK_ROUTINE_NAME = 'Home status line'

export const STATUS_ASK_TEXT = [
  "Write this team's Home status line: one or two short sentences on where the work",
  'stands for a person glancing at Home. Call write_home_summary with it. Do not hand',
  'out work or reply at length.',
].join(' ')

export interface StatusAskDeps {
  db?: ClawbooDb
  mcpBaseUrl?: string | null
  now?: number
  enqueue?: (teamId: string, input: EnqueueUserMessageInput) => Promise<EnqueueUserMessageResult>
}

/** One pass. Returns the teams whose lead was asked. */
export async function askLeadsForStatus(deps: StatusAskDeps = {}): Promise<string[]> {
  const db = deps.db ?? getDb()
  const live = db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.isArchived, 0))
    .all()
    .map((t) => t.id)
  const asked: string[] = []
  for (const teamId of teamsWithLeadStatus(db, live)) {
    if (!resolveServerOrchestrated(db, teamId)) continue
    if (!takeLeadStatusAsk(db, teamId, deps.now)) continue
    const enqueue =
      deps.enqueue ??
      ((id: string, input: EnqueueUserMessageInput) =>
        getTeamOrchestrator(id, { mcpBaseUrl: deps.mcpBaseUrl ?? null }).enqueueUserMessage(input))
    try {
      const result = await enqueue(teamId, {
        stimulus: STATUS_ASK_TEXT,
        routine: { id: `home-status:${teamId}`, name: STATUS_ASK_ROUTINE_NAME },
      })
      if (result.ok) asked.push(teamId)
    } catch {
      // The next pass tries again once its window opens.
    }
  }
  return asked
}

let timer: ReturnType<typeof setInterval> | null = null

/** Start the 15-minute pass. Idempotent; the timer never holds the process open. */
export function startHomeStatusAsks(deps: StatusAskDeps = {}): void {
  if (timer) return
  timer = setInterval(() => {
    if (engineHeld()) return
    void askLeadsForStatus(deps).catch(() => undefined)
  }, STATUS_ASK_INTERVAL_MS)
  timer.unref()
}
