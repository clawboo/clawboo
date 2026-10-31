import { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Plus } from 'lucide-react'
import { apiFetch } from '@clawboo/control-client'
import { useTeamStore, type Team } from '@/stores/team'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'
import { useViewStore } from '@/stores/view'
import { useToastStore } from '@/stores/toast'
import { useMarketplaceStore } from '@/stores/marketplace'
import { confirm } from '@/stores/confirm'
import { deleteAgentOperation } from '@/features/fleet/deleteAgentOperation'
import { TeamContextMenu } from '@/features/teams/TeamContextMenu'
import { refreshTeamAgentsMd } from '@/lib/createAgent'
import { useDismissableLayer } from '@/features/shared/useDismissableLayer'
import { SidebarToggle } from './SidebarToggle'
import type { PeekAnchor } from './sidebarPeek'

/** The rail's top padding (`pt-1.5`), so a peek toggle can land on its anchor. */
const RAIL_PAD_TOP = 6
/** The rail is 60px wide and the toggle 32px: keep it inside the rail. */
const MAX_TOGGLE_LEFT = 28

// ─── RailTip ─────────────────────────────────────────────────────────────────

// How long a rail icon must be hovered before its tooltip shows. The rail used
// the native `title` attribute, whose ~1s delay is browser-controlled and can't
// be shortened — this custom tip appears near-instantly (just enough delay to
// not flicker on pass-through hovers).
const RAIL_TIP_DELAY_MS = 150

/** Fast hover tooltip for the icon rail — rendered to the RIGHT of the icon via
 *  a body portal (so the rail's scroll container never clips it). Replaces the
 *  slow native `title`; the accessible name moves to `aria-label` on the button. */
function RailTip({ label, children }: { label: string; children: React.ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | null>(null)

  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }
  const show = () => {
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      const r = wrapRef.current?.getBoundingClientRect()
      if (r) setPos({ x: r.right + 10, y: r.top + r.height / 2 })
    }, RAIL_TIP_DELAY_MS)
  }
  const hide = () => {
    clearTimer()
    setPos(null)
  }
  useEffect(() => clearTimer, [])

  return (
    <div
      ref={wrapRef}
      className="flex shrink-0"
      onMouseEnter={show}
      onMouseLeave={hide}
      onMouseDown={hide}
    >
      {children}
      {pos &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-[80] whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-1.5 text-[12px] font-medium text-popover-foreground shadow-[var(--shadow-floating)]"
            style={{ left: pos.x, top: pos.y, transform: 'translateY(-50%)' }}
          >
            {label}
          </div>,
          document.body,
        )}
    </div>
  )
}

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
    // Clicking the mascot opens BOO ZERO (the global leader's 1:1 chat) — the
    // "all agents" view is the right-click action — so the tip must say Boo Zero.
    <RailTip label="Boo Zero">
      <button
        onClick={onClick}
        onContextMenu={onContextMenu}
        aria-label="Boo Zero"
        className={[
          'flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-[13px] p-0 transition-all duration-150',
          selected
            ? 'border-2 border-primary bg-primary/10'
            : 'border-2 border-transparent bg-foreground/[0.04] hover:bg-foreground/[0.07]',
        ].join(' ')}
      >
        <img src="logo.svg" width={26} height={24} alt="Boo Zero" />
      </button>
    </RailTip>
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
    <RailTip label={team.name}>
      <div className="relative flex items-center">
        {/* Selected indicator pill on the left edge — brand red. */}
        {selected && (
          <div
            className="absolute h-5 w-1 rounded-r-full"
            style={{ left: -8, background: 'var(--primary)' }}
          />
        )}
        <button
          onClick={onClick}
          onContextMenu={onContextMenu}
          aria-label={team.name}
          className={[
            'flex h-10 w-10 shrink-0 items-center justify-center border-none p-0 text-xl leading-none transition-all duration-200 cursor-pointer',
            selected ? 'rounded-[13px]' : 'rounded-[20px] hover:rounded-[14px]',
            team.color ? '' : 'bg-foreground/[0.06]',
          ].join(' ')}
          style={{
            ...(team.color ? { background: team.color } : {}),
            ...(selected ? { boxShadow: '0 0 0 2px var(--primary)' } : {}),
          }}
        >
          {team.icon}
        </button>
      </div>
    </RailTip>
  )
}

// ─── TeamSidebar ─────────────────────────────────────────────────────────────

/** The confirm copy for Delete with agents. Only an OpenClaw agent lives in a
 *  Gateway, so only a team with one is told about removing it from there
 *  (`runtime` null is a legacy OpenClaw row). */
/** Every agent but an OpenClaw one works in the team's folder on disk, which
 *  deleting the team removes along with its files. */
const TEAM_FOLDER_RUNTIMES = new Set(['claude-code', 'codex', 'hermes', 'clawboo-native'])
const TEAM_FOLDER_NOTE = "The team's folder and the files its agents saved there are deleted too."

function usesTeamFolder(agents: readonly AgentState[]): boolean {
  return agents.some((a) => a.runtime != null && TEAM_FOLDER_RUNTIMES.has(a.runtime))
}

function deleteTeamMessage(agents: readonly AgentState[]): string {
  const base = 'Agents will be kept but unassigned from this team.'
  return usesTeamFolder(agents) ? `${base} ${TEAM_FOLDER_NOTE}` : base
}

function deleteWithAgentsMessage(agents: readonly AgentState[]): string {
  const onGateway = agents.some((a) => a.runtime == null || a.runtime === 'openclaw')
  const what = onGateway
    ? 'This deletes the agents and their chats, and removes the OpenClaw agents from the Gateway.'
    : 'This deletes the agents and their chats.'
  const folder = usesTeamFolder(agents) ? ` ${TEAM_FOLDER_NOTE}` : ''
  return `${what}${folder} It cannot be undone.`
}

/** The sidebar toggle normally sits in the agent column's top row. The rail shows
 *  its own only when there is no agent column (Boo Zero's view), and in the
 *  collapsed sidebar's hover peek, where it sits right under the pointer that
 *  opened the peek; `peek` makes it read "expand" and dock the sidebar. */
export function TeamSidebar({
  peek = false,
  showToggle = true,
  toggleAnchor = null,
}: { peek?: boolean; showToggle?: boolean; toggleAnchor?: PeekAnchor | null } = {}) {
  const teams = useTeamStore((s) => s.teams)
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)
  const selectTeam = useTeamStore((s) => s.selectTeam)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    team: Team
  } | null>(null)

  // Creating a team is now a Marketplace journey: the "+" navigates to the
  // Teams tab (the one canonical, richer team showcase) instead of opening a
  // second, duplicate template picker.
  const openTeamMarketplace = useCallback(() => {
    useMarketplaceStore.getState().setMarketplaceTab('teams')
    useViewStore.getState().navigateTo('marketplace')
  }, [])

  const handleArchiveTeam = useCallback(async () => {
    if (!contextMenu) return
    const { team } = contextMenu
    const wasArchived = team.isArchived
    setContextMenu(null)

    try {
      await apiFetch(`/api/teams/${team.id}`, {
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
    const teamAgents = useFleetStore.getState().agents.filter((a) => a.teamId === team.id)

    setContextMenu(null)

    if (
      !(await confirm({
        title: `Delete "${team.name}"?`,
        message: deleteTeamMessage(teamAgents),
        confirmLabel: 'Delete team',
        tone: 'danger',
      }))
    ) {
      return
    }

    try {
      await apiFetch(`/api/teams/${team.id}`, { method: 'DELETE' })
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

    const teamAgents = useFleetStore.getState().agents.filter((a) => a.teamId === team.id)

    const agentCountText = teamAgents.length === 1 ? '1 agent' : `${teamAgents.length} agents`
    setContextMenu(null)

    if (
      !(await confirm({
        title: `Delete "${team.name}" and ${agentCountText}?`,
        message: deleteWithAgentsMessage(teamAgents),
        confirmLabel: 'Delete everything',
        tone: 'danger',
      }))
    ) {
      return
    }

    // No Gateway gate: deletion is a REST route on this server, which needs none.
    let deletedCount = 0
    try {
      for (const agent of teamAgents) {
        try {
          await deleteAgentOperation(agent.id, agent.sessionKey)
          deletedCount++
        } catch {
          // Continue
        }
      }

      await apiFetch(`/api/teams/${team.id}`, { method: 'DELETE' })
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

  // Escape and outside-press are arbitrated by the shared layer stack: only the
  // topmost open layer reacts, so this dismisses alone.
  useDismissableLayer({
    active: mascotMenu !== null,
    level: 'popover',
    onEscape: () => setMascotMenu(null),
  })

  useEffect(() => {
    if (!mascotMenu) return
    const handleMouseDown = (e: MouseEvent) => {
      if (mascotMenuRef.current && !mascotMenuRef.current.contains(e.target as Node)) {
        setMascotMenu(null)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
    }
  }, [mascotMenu])

  const activeTeams = teams.filter((t) => !t.isArchived)

  return (
    <div
      data-testid="team-sidebar"
      className="flex h-full w-[60px] shrink-0 flex-col items-center gap-2 border-r border-border bg-background pb-3 pt-1.5"
    >
      {/* The toggle lives here only when there is no agent column to hold it,
          and in the peek. There it lands exactly on the header toggle that
          opened the peek, so the click that follows docks the sidebar. */}
      {showToggle && (
        <div
          className="flex h-8 shrink-0 self-stretch"
          style={
            toggleAnchor
              ? {
                  paddingLeft: Math.min(Math.max(0, toggleAnchor.left), MAX_TOGGLE_LEFT),
                  marginTop: Math.max(0, toggleAnchor.top - RAIL_PAD_TOP),
                }
              : { paddingLeft: 8 }
          }
        >
          <SidebarToggle
            collapsed={peek}
            onClick={() => useViewStore.getState().setColumnCollapsed(!peek)}
          />
        </div>
      )}
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
      <div className="flex w-full flex-1 flex-col items-center gap-2 overflow-y-auto px-2.5 py-2">
        {activeTeams.map((team) => (
          <TeamIcon
            key={team.id}
            team={team}
            selected={team.id === selectedTeamId}
            onClick={() => {
              selectTeam(team.id)
              useViewStore.getState().openTeamspace(team.id)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setContextMenu({ x: e.clientX, y: e.clientY, team })
            }}
          />
        ))}
      </div>

      {/* Add team button — opens the Marketplace Teams showcase (the single
          canonical place to browse + deploy a team, or start one from scratch). */}
      <RailTip label="Create a team">
        <button
          aria-label="Create a team"
          onClick={openTeamMarketplace}
          className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-[13px] border border-dashed border-border-strong bg-transparent p-0 text-foreground/40 transition-all duration-150 hover:border-primary hover:text-primary hover:bg-primary/[0.06]"
        >
          <Plus size={16} strokeWidth={2} />
        </button>
      </RailTip>

      {/* Mascot right-click context menu */}
      {mascotMenu && (
        <div
          ref={mascotMenuRef}
          className="fixed z-[60] min-w-[168px] rounded-xl border border-border bg-popover py-1.5 shadow-[var(--shadow-floating)]"
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
            className="block w-full cursor-pointer whitespace-nowrap border-none bg-transparent px-3.5 py-2 text-left text-[13px] text-popover-foreground transition-colors hover:bg-foreground/[0.06]"
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
    </div>
  )
}
