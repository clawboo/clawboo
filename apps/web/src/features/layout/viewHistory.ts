// Back and forward through the views the person moved between, for the slim top
// bar (see EmbedTitlebar). The stacks live in the view store; this adds what the
// store cannot see: whether a remembered page still exists (its agent, its team,
// or its chat room, not deleted or archived since), and the team rail's
// selection, which follows the team a page belongs to just as a click on the
// team's icon does.

import { useShallow } from 'zustand/react/shallow'

import { useFleetStore } from '@/stores/fleet'
import { useRoomStore, type Room } from '@/stores/rooms'
import { useTeamStore, type Team } from '@/stores/team'
import { sameView, useViewStore, type ViewMode } from '@/stores/view'

/** The chat rooms the client knows of: each team's list, and which teams' lists
 *  have been read. A team missing from `loadedTeams` has rooms we have not seen. */
export interface KnownRooms {
  roomsByTeam: ReadonlyMap<string, readonly Pick<Room, 'id'>[]>
  loadedTeams: ReadonlySet<string>
}

/** Whether `mode` can still be shown, given the teams, agent ids and rooms there
 *  are. A room counts as gone only once its team's rooms have been read and it
 *  is not among them: until then nobody knows, and the room page sorts it out. */
export function viewStillExists(
  mode: ViewMode,
  teams: readonly Pick<Team, 'id' | 'isArchived'>[],
  agentIds: readonly string[],
  rooms?: KnownRooms,
): boolean {
  switch (mode.type) {
    case 'agent':
      return agentIds.includes(mode.agentId)
    case 'groupChat': {
      if (!teams.some((t) => t.id === mode.teamId && !t.isArchived)) return false
      if (!mode.roomId || !rooms?.loadedTeams.has(mode.teamId)) return true
      return (rooms.roomsByTeam.get(mode.teamId) ?? []).some((r) => r.id === mode.roomId)
    }
    case 'teamspace':
      return teams.some((t) => t.id === mode.teamId && !t.isArchived)
    default:
      return true
  }
}

function usableNow(mode: ViewMode): boolean {
  return viewStillExists(
    mode,
    useTeamStore.getState().teams,
    useFleetStore.getState().agents.map((a) => a.id),
    useRoomStore.getState(),
  )
}

/** A team's pages select the team, and Boo Zero's page selects none, as the
 *  rail's own clicks do. An agent page selects the agent's team, the column it
 *  was opened from; a teamless agent (Boo Zero is in every team's column) and
 *  every other page leave the selection where it is. */
function followTeam(mode: ViewMode): void {
  const { selectTeam, teams } = useTeamStore.getState()
  if (mode.type === 'groupChat' || mode.type === 'teamspace') selectTeam(mode.teamId)
  else if (mode.type === 'booZero') selectTeam(null)
  else if (mode.type === 'agent') {
    const teamId = useFleetStore.getState().agents.find((a) => a.id === mode.agentId)?.teamId
    if (teamId && teams.some((t) => t.id === teamId && !t.isArchived)) selectTeam(teamId)
  }
}

export function goBack(): void {
  const shown = useViewStore.getState().stepViewHistory('back', usableNow)
  if (shown) followTeam(shown)
}

export function goForward(): void {
  const shown = useViewStore.getState().stepViewHistory('forward', usableNow)
  if (shown) followTeam(shown)
}

/** Whether back and forward have somewhere to go right now. */
export function useViewHistoryState(): { canGoBack: boolean; canGoForward: boolean } {
  const viewMode = useViewStore((s) => s.viewMode)
  const { past, future } = useViewStore((s) => s.viewHistory)
  const teams = useTeamStore((s) => s.teams)
  // Ids only, so a status update on an agent does not re-render the bar.
  const agentIds = useFleetStore(useShallow((s) => s.agents.map((a) => a.id)))
  const rooms = useRoomStore(
    useShallow((s) => ({ roomsByTeam: s.roomsByTeam, loadedTeams: s.loadedTeams })),
  )
  // The same check the buttons step with, so an enabled button always goes somewhere.
  const reachable = (mode: ViewMode) =>
    viewStillExists(mode, teams, agentIds, rooms) && !sameView(mode, viewMode)
  return { canGoBack: past.some(reachable), canGoForward: future.some(reachable) }
}
