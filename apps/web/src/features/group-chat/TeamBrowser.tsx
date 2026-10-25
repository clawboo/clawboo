// The team chat's browser: the newest page each of the team's agents has open,
// with the agents to switch between. The same screen the org chart floats beside
// its graph, standing in the card stack as a window of its own (no card around
// it), with its maximize and close buttons in its top-right corner.

import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { BrowserDock, type DockAgent } from '@/features/graph/BrowserDock'
import { useFleetStore } from '@/stores/fleet'

const NO_TEAMS: never[] = []
const ignore = (): void => undefined

export function TeamBrowser({
  teamId,
  memberIds,
  windowActions,
}: {
  teamId: string
  /** A room's members; null = everyone on the team. */
  memberIds: string[] | null
  /** The window's maximize and close buttons. */
  windowActions?: ReactNode
}) {
  const fleet = useFleetStore((s) => s.agents)
  const memberKey = memberIds ? memberIds.join(',') : null
  const agents = useMemo<DockAgent[]>(() => {
    const members = memberKey === null ? null : new Set(memberKey.split(','))
    return fleet
      .filter((a) => a.teamId === teamId && (!members || members.has(a.id)))
      .map((a) => ({ id: a.id, name: a.name, runtime: a.runtime ?? null }))
  }, [fleet, teamId, memberKey])

  const [selected, setSelected] = useState<string | null>(null)
  // Keep the selection valid: pick when nothing is chosen or the chosen agent left.
  useEffect(() => {
    if (agents.length === 0) {
      if (selected !== null) setSelected(null)
      return
    }
    if (selected && agents.some((a) => a.id === selected)) return
    setSelected(agents[0]?.id ?? null)
  }, [agents, selected])

  return (
    <BrowserDock
      variant="card"
      windowActions={windowActions}
      open
      agents={agents}
      selectedAgentId={selected}
      onSelectAgent={setSelected}
      teams={NO_TEAMS}
      selectedTeamId={null}
      onSelectTeam={ignore}
      onClose={ignore}
    />
  )
}
