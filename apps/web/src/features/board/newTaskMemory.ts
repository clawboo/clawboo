// Which agent this browser last gave a New task to, per team: the suggestion's
// fallback when no word of the sentence matches. A per-viewer convenience, so a
// storage that is blocked or holds junk reads as nothing remembered.

const KEY = 'clawboo.board.new-task-agents'

type Remembered = Record<string, { agentId: string; at: number }>

function read(): Remembered {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Remembered = {}
    for (const [teamId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const { agentId, at } = (entry ?? {}) as { agentId?: unknown; at?: unknown }
      if (typeof agentId === 'string' && typeof at === 'number') out[teamId] = { agentId, at }
    }
    return out
  } catch {
    return {}
  }
}

/** The agents last given a task, most recent first: on `teamId` only, or on
 *  any team when it is null. */
export function recentAssignees(teamId: string | null): string[] {
  return Object.entries(read())
    .filter(([team]) => teamId === null || team === teamId)
    .sort(([, a], [, b]) => b.at - a.at)
    .map(([, entry]) => entry.agentId)
}

export function rememberAssignee(teamId: string, agentId: string): void {
  try {
    const next = { ...read(), [teamId]: { agentId, at: Date.now() } }
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Not remembered; the next suggestion falls back to the team lead.
  }
}
