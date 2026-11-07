// What a person has paused: agents, teams and task trees. The server's table is the
// truth (GET /api/pauses); this holds a copy for everything that shows one. It is
// read at start and again whenever the event log says a pause was placed or lifted
// (see RunStatusBridge), so another tab or person's pause shows here too.

import { create } from 'zustand'

import { apiFetch } from '@clawboo/control-client'

import { isPersonOnlyRefusal } from '@/lib/personCheckNotice'

export type PauseKind = 'agent' | 'team' | 'task_tree'

export interface PauseView {
  kind: PauseKind
  id: string
  /** The agent's or team's name, or the root task's title. */
  name: string
  reason: string | null
  /** Who paused it, when a sign-in proxy vouched for them; null for the local person. */
  pausedBy: { id: string; name: string | null; role: string | null } | null
  pausedAt: number
}

/** What a request names: an agent, a team, or any task in a tree. */
export type PauseTarget = { kind: 'agent' | 'team' | 'task'; id: string }

/** How a pause or a resume went. `person_only`: the server's person check refused it,
 *  which trying again would not change. */
export type PauseWrite = 'done' | 'person_only' | 'failed'

const refusedAs = async (res: Response): Promise<PauseWrite> =>
  (await isPersonOnlyRefusal(res)) ? 'person_only' : 'failed'

interface PauseState {
  pauses: PauseView[]
  refresh(): Promise<void>
  /** Resolves `done` when it is paused. */
  pause(target: PauseTarget): Promise<PauseWrite>
  /** Resolves `done` when it is resumed. A pause already gone counts. */
  resume(target: PauseTarget): Promise<PauseWrite>
}

export const usePauseStore = create<PauseState>((set, get) => ({
  pauses: [],
  async refresh() {
    try {
      const res = await apiFetch('/api/pauses')
      if (!res.ok) return
      const body = (await res.json()) as { pauses?: PauseView[] }
      set({ pauses: body.pauses ?? [] })
    } catch {
      // The next event or the next start reads it again.
    }
  },
  async pause(target) {
    try {
      const res = await apiFetch('/api/pauses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target),
      })
      if (!res.ok) return await refusedAs(res)
      await get().refresh()
      return 'done'
    } catch {
      return 'failed'
    }
  },
  async resume(target) {
    try {
      const res = await apiFetch(
        `/api/pauses/${encodeURIComponent(target.kind)}/${encodeURIComponent(target.id)}`,
        { method: 'DELETE' },
      )
      if (!res.ok && res.status !== 404) return await refusedAs(res)
      await get().refresh()
      return 'done'
    } catch {
      return 'failed'
    }
  },
}))

/** The pause covering an agent: its own, else its team's. The same order the server
 *  reads them in, so what shows is what holds it back. */
export function pauseOfAgent(
  pauses: readonly PauseView[],
  agentId: string,
  teamId: string | null | undefined,
): PauseView | null {
  return (
    pauses.find((p) => p.kind === 'agent' && p.id === agentId) ??
    (teamId ? pauseOfTeam(pauses, teamId) : null)
  )
}

export function pauseOfTeam(pauses: readonly PauseView[], teamId: string): PauseView | null {
  return pauses.find((p) => p.kind === 'team' && p.id === teamId) ?? null
}

/** The pause a team chat shows: its team's, else its lead's own, since every message
 *  that names nobody goes to the lead. A paused Boo Zero leads in every team. */
export function pauseOfTeamChat(
  pauses: readonly PauseView[],
  teamId: string,
  leadAgentId: string | null | undefined,
): PauseView | null {
  return (
    pauseOfTeam(pauses, teamId) ??
    (leadAgentId ? (pauses.find((p) => p.kind === 'agent' && p.id === leadAgentId) ?? null) : null)
  )
}

/** What a Resume names for a pause. */
export function pauseTarget(pause: PauseView): PauseTarget {
  return { kind: pause.kind === 'task_tree' ? 'task' : pause.kind, id: pause.id }
}

/** "Ada is paused", and so on: what is paused, for a person. */
export function pauseSubjectWords(pause: Pick<PauseView, 'kind' | 'name'>): string {
  if (pause.kind === 'agent') return `${pause.name} is paused`
  if (pause.kind === 'team') return `The ${pause.name} team is paused`
  return `“${pause.name}” and the tasks under it are paused`
}

/** "You paused it", or the person a sign-in proxy named. */
export function pausedByWords(pause: Pick<PauseView, 'pausedBy'>): string {
  const who = pause.pausedBy?.name ?? pause.pausedBy?.id ?? null
  return who ? `${who} paused it` : 'You paused it'
}
