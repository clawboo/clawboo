import { useState, useCallback } from 'react'
import { Plus } from 'lucide-react'
import { useTeamStore, type Team } from '@/stores/team'
import { useFleetStore } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'
import { useViewStore } from '@/stores/view'
import { useToastStore } from '@/stores/toast'
import { deleteAgentOperation } from '@/features/fleet/deleteAgentOperation'
import { CreateTeamModal } from '@/features/teams/CreateTeamModal'
import { TeamContextMenu } from '@/features/teams/TeamContextMenu'
import { hydrateTeams } from '@/lib/hydrateTeams'
import { useGraphStore } from '@/features/graph/store'

// ─── MascotIcon ──────────────────────────────────────────────────────────────

function MascotIcon({ selected, onClick }: { selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
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
    useViewStore.getState().navigateTo('graph')
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
      {/* Mascot — opens Boo Zero view */}
      <MascotIcon
        selected={selectedTeamId === null}
        onClick={() => {
          selectTeam(null)
          useViewStore.getState().openBooZero()
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
              selectTeam(team.id)
              useViewStore.getState().navigateTo('graph')
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

      {contextMenu && (
        <TeamContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          teamName={contextMenu.team.name}
          isArchived={contextMenu.team.isArchived}
          onClose={() => setContextMenu(null)}
          onArchive={handleArchiveTeam}
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
