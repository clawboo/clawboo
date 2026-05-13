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
      style={{
        width: 40,
        height: 40,
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: selected ? '2px solid #E94560' : '2px solid transparent',
        background: selected ? 'rgba(233,69,96,0.12)' : 'rgba(255,255,255,0.04)',
        cursor: 'pointer',
        transition: 'all 0.15s',
        padding: 0,
        flexShrink: 0,
      }}
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
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      {/* Discord-style selected pill on left edge */}
      {selected && (
        <div
          style={{
            position: 'absolute',
            left: -8,
            width: 4,
            height: 20,
            borderRadius: '0 4px 4px 0',
            background: '#E8E8E8',
          }}
        />
      )}
      <button
        onClick={onClick}
        onContextMenu={onContextMenu}
        title={team.name}
        style={{
          width: 40,
          height: 40,
          borderRadius: selected ? 12 : 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          background: team.color || 'rgba(255,255,255,0.06)',
          cursor: 'pointer',
          transition: 'all 0.15s',
          padding: 0,
          flexShrink: 0,
          fontSize: 20,
          lineHeight: 1,
        }}
        onMouseOver={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.borderRadius = '12px'
        }}
        onMouseOut={(e) => {
          if (!selected) {
            ;(e.currentTarget as HTMLButtonElement).style.borderRadius = '20px'
          }
        }}
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
    // `CreateTeamModal` calls `useTeamStore.selectTeam(team.id)` right before
    // firing `onCreated`, so by this point the newly-created team is the
    // selected one. Open its group chat directly — that's where the user
    // expects to land after deploying a team (chat with the new agents,
    // or run through onboarding if it's a template team with no history).
    // Fall back to Atlas defensively if selection didn't stick for some
    // reason (e.g. an upstream rejection deselected the team).
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
        // If archived team was selected, navigate away
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

      // Orphan agents in fleet store
      useFleetStore.setState((s) => ({
        agents: s.agents.map((a) => (a.teamId === team.id ? { ...a, teamId: null } : a)),
      }))

      // If the deleted team was selected, go to Boo Zero
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
      // Delete each agent from Gateway
      if (client) {
        for (const agent of teamAgents) {
          try {
            await deleteAgentOperation(agent.id, agent.sessionKey, client)
            deletedCount++
          } catch {
            // Continue deleting remaining agents
          }
        }
      }

      // Delete the team from SQLite
      await fetch(`/api/teams/${team.id}`, { method: 'DELETE' })
      useTeamStore.getState().removeTeam(team.id)

      // If the deleted team was selected, go to Boo Zero
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
        // Best-effort — continue with remaining agents
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

  // ── Mascot right-click menu ─────────────────────────────────────────────────
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
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: 60,
        height: '100%',
        borderRight: '1px solid rgba(255,255,255,0.06)',
        background: '#080B14',
        paddingTop: 12,
        paddingBottom: 12,
        gap: 8,
        flexShrink: 0,
      }}
    >
      {/* Mascot — left click: Boo Zero view; right click: show all agents */}
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
      <div
        style={{
          width: 32,
          borderTop: '1px solid rgba(255,255,255,0.08)',
          marginTop: 2,
          marginBottom: 2,
          flexShrink: 0,
        }}
      />

      {/* Team icons */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          paddingLeft: 10,
          paddingRight: 10,
        }}
      >
        {activeTeams.map((team) => (
          <TeamIcon
            key={team.id}
            team={team}
            selected={team.id === selectedTeamId}
            onClick={() => {
              // Clicking a team icon opens that team's Group Chat — the
              // primary view for working WITH the team. (Atlas is the
              // cross-team org-wide view, reachable from the nav slot
              // labelled "🌐 Atlas" in the agent-list column.)
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
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px dashed rgba(255,255,255,0.12)',
          background: 'transparent',
          color: 'rgba(232,232,232,0.3)',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
          transition: 'all 0.15s',
        }}
        onMouseOver={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(233,69,96,0.4)'
          ;(e.currentTarget as HTMLButtonElement).style.color = 'rgba(233,69,96,0.7)'
        }}
        onMouseOut={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.12)'
          ;(e.currentTarget as HTMLButtonElement).style.color = 'rgba(232,232,232,0.3)'
        }}
      >
        <Plus size={16} strokeWidth={2} />
      </button>

      {/* Column 2 collapse/expand toggle — always visible */}
      <button
        title={columnCollapsed || isBooZero ? 'Expand sidebar' : 'Collapse sidebar'}
        onClick={() => {
          // If in Boo Zero view, exit to graph with column visible
          if (isBooZero) {
            useViewStore.getState().navigateTo('graph')
            if (useViewStore.getState().columnCollapsed) {
              useViewStore.getState().toggleColumnCollapsed()
            }
          } else {
            useViewStore.getState().toggleColumnCollapsed()
          }
        }}
        style={{
          width: 40,
          height: 40,
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          background: 'transparent',
          color: 'rgba(232,232,232,0.3)',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
          transition: 'all 0.15s',
        }}
        onMouseOver={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.color = 'rgba(232,232,232,0.7)'
        }}
        onMouseOut={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.color = 'rgba(232,232,232,0.3)'
        }}
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
          style={{
            position: 'fixed',
            left: mascotMenu.x,
            top: mascotMenu.y,
            zIndex: 60,
            background: '#111827',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            padding: '4px 0',
            minWidth: 160,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          }}
        >
          <button
            type="button"
            onClick={() => {
              selectTeam(null)
              useViewStore.getState().navigateTo('graph')
              // Ensure column is visible
              if (useViewStore.getState().columnCollapsed) {
                useViewStore.getState().toggleColumnCollapsed()
              }
              setMascotMenu(null)
            }}
            style={{
              display: 'block',
              width: '100%',
              padding: '8px 14px',
              background: 'transparent',
              border: 'none',
              color: '#E8E8E8',
              fontSize: 12,
              textAlign: 'left',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'background 0.1s',
            }}
            onMouseOver={(e) => {
              ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)'
            }}
            onMouseOut={(e) => {
              ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
            }}
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
