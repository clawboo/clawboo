import { useState, useCallback, useEffect, useRef } from 'react'
import { PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react'
import { useTeamStore, type Team } from '@/stores/team'
import { useFleetStore } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'
import { useViewStore } from '@/stores/view'
import { useToastStore } from '@/stores/toast'
import { deleteAgentOperation } from '@/features/fleet/deleteAgentOperation'
import { CreateTeamModal } from '@/features/teams/CreateTeamModal'
import { TeamContextMenu } from '@/features/teams/TeamContextMenu'
import { refreshTeamAgentsMd } from '@/lib/createAgent'
import { hydrateTeams } from '@/lib/hydrateTeams'
import { useGraphStore } from '@/features/graph/store'

// ─── MascotIcon ──────────────────────────────────────────────────────────────

function MascotIcon({
  selected,
  onClick,
  onContextMenu,
}: {
  selected: boolean
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      title="All Agents"
      className={[
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] p-0 transition-all duration-150',
        selected
          ? 'border-2 border-primary bg-primary/12'
          : 'border-2 border-transparent bg-foreground/[0.04] hover:bg-foreground/[0.07]',
      ].join(' ')}
    >
      <img src="/logo.svg" width={26} height={24} alt="All teams" />
    </button>
  )
}

// ─── TeamIcon ────────────────────────────────────────────────────────────────

function TeamIcon({
  team,
  selected,
  onClick,
  onContextMenu,
}: {
  team: Team
  selected: boolean
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  return (
    <div className="relative flex items-center">
      {/* Discord-style selected pill on left edge */}
      {selected && (
        <div className="absolute h-5 w-1 rounded-r bg-foreground" style={{ left: -8 }} />
      )}
      <button
        onClick={onClick}
        onContextMenu={onContextMenu}
        title={team.name}
        className={[
          'flex h-10 w-10 shrink-0 items-center justify-center border-none p-0 text-xl leading-none transition-all duration-150',
          selected ? 'rounded-[12px]' : 'rounded-[20px] hover:rounded-[12px]',
          team.color ? '' : 'bg-foreground/[0.06]',
        ].join(' ')}
        style={team.color ? { background: team.color } : undefined}
      >
        {team.icon}
      </button>
    </div>
  )
}

// ─── TeamSidebar ─────────────────────────────────────────────────────────────

export function TeamSidebar() {
  const teams = useTeamStore((s) => s.teams)
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)
  const selectTeam = useTeamStore((s) => s.selectTeam)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    team: Team
  } | null>(null)

  const handleTeamCreated = useCallback(async () => {
    setShowCreateModal(false)
    await hydrateTeams()
    useGraphStore.getState().triggerRefresh()
    const newTeamId = useTeamStore.getState().selectedTeamId
    if (newTeamId) {
      useViewStore.getState().openGroupChat(newTeamId)
    } else {
      useViewStore.getState().navigateTo('graph')
    }
  }, [])

  const handleArchiveTeam = useCallback(async () => {
    if (!contextMenu) return
    const { team } = contextMenu
    const wasArchived = team.isArchived
    setContextMenu(null)

    try {
      await fetch(`/api/teams/${team.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isArchived: wasArchived ? 0 : 1 }),
      })
      if (wasArchived) {
        useTeamStore.getState().unarchiveTeam(team.id)
      } else {
        useTeamStore.getState().archiveTeam(team.id)
        if (useTeamStore.getState().selectedTeamId === null) {
          useViewStore.getState().openBooZero()
        }
      }
      useToastStore.getState().addToast({
        type: 'success',
        message: wasArchived ? `"${team.name}" unarchived` : `"${team.name}" archived`,
      })
    } catch {
      useToastStore.getState().addToast({
        type: 'error',
        message: 'Failed to update team',
      })
    }
  }, [contextMenu])

  const handleDeleteTeam = useCallback(async () => {
    if (!contextMenu) return
    const { team } = contextMenu

    if (
      !window.confirm(
        `Delete team "${team.name}"? Agents will be kept but unassigned from this team.`,
      )
    ) {
      setContextMenu(null)
      return
    }

    setContextMenu(null)

    try {
      await fetch(`/api/teams/${team.id}`, { method: 'DELETE' })
      useTeamStore.getState().removeTeam(team.id)

      useFleetStore.setState((s) => ({
        agents: s.agents.map((a) => (a.teamId === team.id ? { ...a, teamId: null } : a)),
      }))

      if (useTeamStore.getState().selectedTeamId === null) {
        useViewStore.getState().openBooZero()
      }

      useToastStore.getState().addToast({
        type: 'success',
        message: `"${team.name}" deleted`,
      })
    } catch {
      useToastStore.getState().addToast({
        type: 'error',
        message: 'Failed to delete team',
      })
    }
  }, [contextMenu])

  const handleDeleteTeamWithAgents = useCallback(async () => {
    if (!contextMenu) return
    const { team } = contextMenu
    const client = useConnectionStore.getState().client

    const teamAgents = useFleetStore.getState().agents.filter((a) => a.teamId === team.id)

    const agentCountText = teamAgents.length === 1 ? '1 agent' : `${teamAgents.length} agents`
    if (
      !window.confirm(
        `Delete team "${team.name}" and ${agentCountText}? This will permanently remove the agents from the Gateway.`,
      )
    ) {
      setContextMenu(null)
      return
    }

    setContextMenu(null)

    let deletedCount = 0
    try {
      if (client) {
        for (const agent of teamAgents) {
          try {
            await deleteAgentOperation(agent.id, agent.sessionKey, client)
            deletedCount++
          } catch {
            // Continue
          }
        }
      }

      await fetch(`/api/teams/${team.id}`, { method: 'DELETE' })
      useTeamStore.getState().removeTeam(team.id)

      if (useTeamStore.getState().selectedTeamId === null) {
        useViewStore.getState().openBooZero()
      }

      if (deletedCount === teamAgents.length) {
        useToastStore.getState().addToast({
          type: 'success',
          message: `"${team.name}" and ${agentCountText} deleted`,
        })
      } else {
        useToastStore.getState().addToast({
          type: 'error',
          message: `"${team.name}" deleted but only ${deletedCount}/${teamAgents.length} agents removed`,
        })
      }
    } catch {
      useToastStore.getState().addToast({
        type: 'error',
        message: 'Failed to delete team',
      })
    }
  }, [contextMenu])

  const handleRefreshProtocol = useCallback(async () => {
    if (!contextMenu) return
    const { team } = contextMenu
    const client = useConnectionStore.getState().client
    if (!client) {
      useToastStore.getState().addToast({ type: 'error', message: 'Not connected to Gateway' })
      setContextMenu(null)
      return
    }

    const teamAgents = useFleetStore.getState().agents.filter((a) => a.teamId === team.id)
    if (teamAgents.length === 0) {
      useToastStore.getState().addToast({ type: 'error', message: 'No agents in this team' })
      setContextMenu(null)
      return
    }

    setContextMenu(null)

    useToastStore.getState().addToast({
      type: 'success',
      message: `Refreshing protocol for ${teamAgents.length} agent${teamAgents.length !== 1 ? 's' : ''}...`,
    })

    let successCount = 0
    for (const agent of teamAgents) {
      try {
        const teammates = teamAgents
          .filter((a) => a.id !== agent.id)
          .map((a) => ({ name: a.name, role: a.name }))
        await refreshTeamAgentsMd({
          client,
          agentId: agent.id,
          agentName: agent.name,
          teamName: team.name,
          teammates,
        })
        successCount++
      } catch {
        // Best-effort
      }
    }

    useToastStore.getState().addToast({
      type: successCount === teamAgents.length ? 'success' : 'error',
      message:
        successCount === teamAgents.length
          ? `Protocol refreshed for ${successCount} agent${successCount !== 1 ? 's' : ''}`
          : `Protocol refreshed for ${successCount}/${teamAgents.length} agents`,
    })
  }, [contextMenu])

  const [mascotMenu, setMascotMenu] = useState<{ x: number; y: number } | null>(null)
  const mascotMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!mascotMenu) return
    const handleMouseDown = (e: MouseEvent) => {
      if (mascotMenuRef.current && !mascotMenuRef.current.contains(e.target as Node)) {
        setMascotMenu(null)
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMascotMenu(null)
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [mascotMenu])

  const isBooZero = useViewStore((s) => s.viewMode.type === 'booZero')
  const columnCollapsed = useViewStore((s) => s.columnCollapsed)

  const activeTeams = teams.filter((t) => !t.isArchived)

  return (
    <div
      data-testid="team-sidebar"
      className="flex h-full w-[60px] shrink-0 flex-col items-center gap-2 border-r border-border bg-muted/60 pb-3 pt-3 dark:bg-[#080B14]"
    >
      <MascotIcon
        selected={selectedTeamId === null}
        onClick={() => {
          selectTeam(null)
          useViewStore.getState().openBooZero()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMascotMenu({ x: e.clientX, y: e.clientY })
        }}
      />

      {/* Divider */}
      <div className="w-8 shrink-0 border-t border-border" />

      {/* Team icons */}
      <div className="flex w-full flex-1 flex-col items-center gap-2 overflow-y-auto px-2.5">
        {activeTeams.map((team) => (
          <TeamIcon
            key={team.id}
            team={team}
            selected={team.id === selectedTeamId}
            onClick={() => {
              selectTeam(team.id)
              useViewStore.getState().openGroupChat(team.id)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setContextMenu({ x: e.clientX, y: e.clientY, team })
            }}
          />
        ))}
      </div>

      {/* Add team button */}
      <button
        title="Create team"
        onClick={() => setShowCreateModal(true)}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-border bg-transparent p-0 text-secondary/40 transition-all duration-150 hover:border-primary/40 hover:text-primary/70"
      >
        <Plus size={16} strokeWidth={2} />
      </button>

      {/* Column 2 collapse/expand toggle */}
      <button
        title={columnCollapsed || isBooZero ? 'Expand sidebar' : 'Collapse sidebar'}
        onClick={() => {
          if (isBooZero) {
            useViewStore.getState().navigateTo('graph')
            if (useViewStore.getState().columnCollapsed) {
              useViewStore.getState().toggleColumnCollapsed()
            }
          } else {
            useViewStore.getState().toggleColumnCollapsed()
          }
        }}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border-none bg-transparent p-0 text-secondary/40 transition-all duration-150 hover:text-foreground/70"
      >
        {columnCollapsed || isBooZero ? (
          <PanelLeftOpen size={16} strokeWidth={2} />
        ) : (
          <PanelLeftClose size={16} strokeWidth={2} />
        )}
      </button>

      {/* Mascot right-click context menu */}
      {mascotMenu && (
        <div
          ref={mascotMenuRef}
          className="fixed z-[60] min-w-[160px] rounded-lg border border-border bg-popover py-1 shadow-lg"
          style={{ left: mascotMenu.x, top: mascotMenu.y }}
        >
          <button
            type="button"
            onClick={() => {
              selectTeam(null)
              useViewStore.getState().navigateTo('graph')
              if (useViewStore.getState().columnCollapsed) {
                useViewStore.getState().toggleColumnCollapsed()
              }
              setMascotMenu(null)
            }}
            className="block w-full whitespace-nowrap border-none bg-transparent px-3.5 py-2 text-left text-xs text-popover-foreground transition-colors hover:bg-foreground/5"
          >
            Show all agents
          </button>
        </div>
      )}

      {contextMenu && (
        <TeamContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          teamName={contextMenu.team.name}
          isArchived={contextMenu.team.isArchived}
          onClose={() => setContextMenu(null)}
          onArchive={handleArchiveTeam}
          onRefreshProtocol={handleRefreshProtocol}
          onDelete={handleDeleteTeam}
          onDeleteWithAgents={handleDeleteTeamWithAgents}
        />
      )}

      <CreateTeamModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={handleTeamCreated}
      />
    </div>
  )
}
