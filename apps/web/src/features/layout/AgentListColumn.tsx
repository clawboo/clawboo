import { useState, useMemo, useEffect, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Plus, Search, Trash2 } from 'lucide-react'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useTeamStore, type Team } from '@/stores/team'
import { useConnectionStore } from '@/stores/connection'
import { useViewStore, type NavView } from '@/stores/view'
import { useApprovalsStore } from '@/stores/approvals'
import { CreateBooModal } from '@/features/fleet/CreateBooModal'
import { deleteAgentOperation } from '@/features/fleet/deleteAgentOperation'
import { useBooZeroStore, identifyBooZero } from '@/stores/booZero'
import type { AgentStatus } from '@clawboo/gateway-client'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatLastSeen(lastSeenAt: number | null): string | null {
  if (!lastSeenAt) return null
  const diff = Date.now() - lastSeenAt
  if (diff < 60_000) return 'seen just now'
  if (diff < 3_600_000) return `seen ${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `seen ${Math.floor(diff / 3_600_000)}h ago`
  return `seen ${Math.floor(diff / 86_400_000)}d ago`
}

// ─── Agent avatar ────────────────────────────────────────────────────────────

function AgentAvatar({ agent, selected }: { agent: AgentState; selected: boolean }) {
  return (
    <span
      aria-hidden
      className="shrink-0 transition-all duration-200"
      style={{
        display: 'inline-flex',
        borderRadius: 8,
        boxShadow: selected
          ? '0 0 0 2px rgba(233,69,96,0.55)'
          : '0 0 0 1.5px rgba(255,255,255,0.06)',
        background: '#0A0E1A',
      }}
    >
      <AgentBooAvatar agentId={agent.id} size={32} />
    </span>
  )
}

// ─── Status badge ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  AgentStatus,
  { label: string; dot: string; badge: string; pulse: boolean }
> = {
  idle: {
    label: 'Idle',
    dot: 'bg-secondary',
    badge: 'bg-surface text-secondary border border-white/5',
    pulse: false,
  },
  running: {
    label: 'Working',
    dot: 'bg-mint',
    badge: 'bg-mint/10 text-mint border border-mint/20',
    pulse: true,
  },
  error: {
    label: 'Error',
    dot: 'bg-destructive',
    badge: 'bg-destructive/10 text-destructive border border-destructive/20',
    pulse: false,
  },
  sleeping: {
    label: 'Sleeping',
    dot: 'bg-secondary/40',
    badge: 'bg-surface text-secondary/50 border border-white/5',
    pulse: false,
  },
}

function StatusBadge({ status }: { status: AgentStatus }) {
  const cfg = STATUS_CONFIG[status]
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={status}
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.85 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide ${cfg.badge}`}
      >
        <span className="relative flex h-1.5 w-1.5">
          {cfg.pulse && (
            <motion.span
              className={`absolute inset-0 rounded-full ${cfg.dot}`}
              animate={{ scale: [1, 1.8], opacity: [0.6, 0] }}
              transition={{ repeat: Infinity, duration: 1.4, ease: 'easeOut' }}
            />
          )}
          <span className={`relative inline-block h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
        </span>
        {cfg.label}
      </motion.span>
    </AnimatePresence>
  )
}

// ─── Agent row ───────────────────────────────────────────────────────────────

function AgentRow({
  agent,
  selected,
  onSelect,
  onDelete,
}: {
  agent: AgentState
  selected: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  return (
    <motion.div
      layout
      data-testid={`fleet-agent-row-${agent.id}`}
      className={[
        'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2',
        'transition-colors duration-150',
        selected ? 'bg-white/6 shadow-sm' : 'hover:bg-white/4',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <AgentAvatar agent={agent} selected={selected} />
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-[12px] font-medium leading-tight text-text"
            style={{ fontFamily: 'var(--font-body)' }}
          >
            {agent.name}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <StatusBadge status={agent.status} />
            {agent.status !== 'running' && formatLastSeen(agent.lastSeenAt) && (
              <span className="text-[9px] text-secondary/40">
                {formatLastSeen(agent.lastSeenAt)}
              </span>
            )}
          </div>
        </div>
      </button>

      <button
        type="button"
        aria-label={`Delete ${agent.name}`}
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className="shrink-0 rounded p-1 text-secondary/40 opacity-0 transition-all hover:text-destructive group-hover:opacity-100"
      >
        <Trash2 className="h-3 w-3" strokeWidth={2} />
      </button>
    </motion.div>
  )
}

// ─── Nav items ───────────────────────────────────────────────────────────────

const PRIMARY_NAV: { id: NavView; label: string; emoji: string }[] = [
  // `'graph'` opens Atlas — the global all-teams view with Boo Zero at
  // the top of the hierarchy. Renamed from "Ghost Graph" because the
  // team-scoped Ghost Graph still lives inside Group Chat; this slot is
  // now specifically the org-wide map.
  { id: 'graph', label: 'Atlas', emoji: '🌐' },
  { id: 'marketplace', label: 'Marketplace', emoji: '🛒' },
]

const SECONDARY_NAV: { id: NavView; label: string; emoji: string }[] = [
  { id: 'approvals', label: 'Approvals', emoji: '🔐' },
  { id: 'scheduler', label: 'Scheduler', emoji: '⏰' },
  { id: 'cost', label: 'Tokens Used', emoji: '📊' },
  { id: 'system', label: 'System', emoji: '⚙️' },
]

// ─── Group chat row ─────────────────────────────────────────────────────────
//
// Single-row horizontal button: avatar stack (the "team photo") on the
// LEFT, "Group Chat" label + chevron on the RIGHT. Earlier vertical
// designs (label-above-photo) read as a section heading because of the
// stacked vertical layout — putting everything on one row of similar
// height to the agent rows below makes it unambiguously a button while
// still showing off the team identity through the live Boo avatars.
//
//   - Up to MAX_VISIBLE_AVATARS Boos are shown; remaining ones collapse
//     into a "+N" badge at the end of the stack.
//   - The leader (when known) is placed FIRST so it sits at the front of
//     the overlap stack.
//   - Each avatar has a 2px ring in the surface color so adjacent
//     overlapping avatars read as separate faces, not a blurred mass.
//     The ring color is FIXED — earlier versions switched it to the team
//     accent on selection but the colored rings read as congested.
//   - Right side: "Group Chat" label + a chevron-right icon. The
//     chevron is the standard "navigate to" affordance so the button
//     reads as interactive even when nothing is hovered.
//   - Selection feedback is via the surface background only (lightens
//     on hover, lightens further when active).

// Avatars are 28px so 4 of them + the "Group Chat" label + status badge
// all fit on a single line within the 191px-wide column. (At 30px the
// stack ate just enough horizontal space that "Group Chat" overflowed
// its container by 1px and triggered the truncate ellipsis.) The right
// side mirrors the agent row's layout — name on top, status badge below
// — so the Group Chat row reads as a structural peer of the agent rows.
//   - Team has 1–4 agents: show ALL of them (no "+N" badge needed)
//   - Team has 5+ agents:  show 3 avatars + "+N" badge
// This caps the avatar stack at 4 items wide regardless of team size.
const GROUP_CHAT_AVATAR_SIZE = 28
const GROUP_CHAT_STRIDE = 18 // 28 - 18 = 10px overlap between adjacent avatars
const GROUP_CHAT_MAX_VISIBLE_NO_OVERFLOW = 4
const GROUP_CHAT_MAX_VISIBLE_WITH_OVERFLOW = 3

// The avatar-stack column has a FIXED width regardless of how many
// avatars the team actually contributes — sized to hold the maximum
// (4 items wide). Without this, smaller teams produced a narrower
// stack which let the right-side "Group Chat / Idle" text shift left,
// so the same label rendered at different X positions across teams.
// A fixed-width left column keeps the label / status badge aligned
// to the same column edge in every team size.
const GROUP_CHAT_STACK_WIDTH =
  GROUP_CHAT_AVATAR_SIZE + (GROUP_CHAT_MAX_VISIBLE_NO_OVERFLOW - 1) * GROUP_CHAT_STRIDE

function orderTeamAgentsForPhoto(team: Team, teamAgents: AgentState[]): AgentState[] {
  if (!team.leaderAgentId) return teamAgents
  const leaderIndex = teamAgents.findIndex((a) => a.id === team.leaderAgentId)
  if (leaderIndex <= 0) return teamAgents
  // Move leader to position 0; preserve relative order of the rest.
  const reordered = [...teamAgents]
  const [leader] = reordered.splice(leaderIndex, 1)
  if (leader) reordered.unshift(leader)
  return reordered
}

// Aggregate the team's overall status from its members. Mirrors the
// status badge shown on individual agent rows so the Group Chat row
// reads as a peer in the list. Priority: any running > any error >
// any sleeping > idle.
function aggregateTeamStatus(teamAgents: AgentState[]): AgentStatus {
  if (teamAgents.length === 0) return 'idle'
  if (teamAgents.some((a) => a.status === 'running')) return 'running'
  if (teamAgents.some((a) => a.status === 'error')) return 'error'
  if (teamAgents.some((a) => a.status === 'sleeping')) return 'sleeping'
  return 'idle'
}

function GroupChatRow({
  team,
  teamAgents,
  isActive,
  onClick,
}: {
  team: Team
  teamAgents: AgentState[]
  isActive: boolean
  onClick: () => void
}) {
  const ordered = orderTeamAgentsForPhoto(team, teamAgents)
  // If the team is small enough to show every agent, do so. Otherwise
  // cap at WITH_OVERFLOW so the "+N" badge fits alongside the label.
  const willOverflow = ordered.length > GROUP_CHAT_MAX_VISIBLE_NO_OVERFLOW
  const visibleCount = willOverflow ? GROUP_CHAT_MAX_VISIBLE_WITH_OVERFLOW : ordered.length
  const visible = ordered.slice(0, visibleCount)
  const overflow = Math.max(0, ordered.length - visibleCount)
  // Ring color is fixed in the surface color so it acts purely as a
  // separator between overlapping avatars (visually invisible against the
  // surface). It does NOT switch to the team accent on selection.
  const ringColor = '#111827'

  const aggregateStatus = aggregateTeamStatus(ordered)

  return (
    <button
      type="button"
      data-testid="group-chat-row"
      onClick={onClick}
      title={`${team.name} — Group Chat (${ordered.length} agent${ordered.length === 1 ? '' : 's'})`}
      className={[
        // py-2 + the right-side label-on-top + status-below stack mirror
        // the agent rows below exactly — same outer height (~56px) and
        // same internal vertical rhythm.
        'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2',
        'transition-colors duration-150',
        isActive ? 'bg-white/8 shadow-sm' : 'hover:bg-white/4',
      ].join(' ')}
    >
      {/* Team photo — overlapping Boo avatars on the left. The container
          has a FIXED width (GROUP_CHAT_STACK_WIDTH) regardless of how
          many avatars are visible, so the right-side label / status
          column starts at the same X across every team size. */}
      <div className="flex items-center" style={{ width: GROUP_CHAT_STACK_WIDTH, flexShrink: 0 }}>
        {visible.map((agent, i) => (
          <div
            key={agent.id}
            title={agent.name}
            style={{
              marginLeft: i === 0 ? 0 : -(GROUP_CHAT_AVATAR_SIZE - GROUP_CHAT_STRIDE),
              width: GROUP_CHAT_AVATAR_SIZE,
              height: GROUP_CHAT_AVATAR_SIZE,
              borderRadius: '50%',
              border: `2px solid ${ringColor}`,
              overflow: 'hidden',
              flexShrink: 0,
              // Earlier (leftmost) avatars sit ON TOP — the leader is at
              // index 0, so they dominate the front of the team photo.
              zIndex: visible.length - i,
              boxShadow: '0 1px 2px rgba(0,0,0,0.4)',
              background: '#0A0E1A',
            }}
          >
            <AgentBooAvatar agentId={agent.id} size={GROUP_CHAT_AVATAR_SIZE} />
          </div>
        ))}
        {overflow > 0 && (
          <div
            title={`${overflow} more ${overflow === 1 ? 'agent' : 'agents'}`}
            style={{
              marginLeft: -(GROUP_CHAT_AVATAR_SIZE - GROUP_CHAT_STRIDE),
              width: GROUP_CHAT_AVATAR_SIZE,
              height: GROUP_CHAT_AVATAR_SIZE,
              borderRadius: '50%',
              border: `2px solid ${ringColor}`,
              background: '#1f2937',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              fontWeight: 700,
              color: 'rgba(232,232,232,0.75)',
              flexShrink: 0,
              zIndex: 0,
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.02em',
            }}
          >
            +{overflow}
          </div>
        )}
      </div>

      {/* Right side — "Group Chat" name on top, aggregate status badge
          below. Vertically stacked the same way agent rows lay out
          [name / status badge], so the Group Chat row reads as a
          structural peer of the agents listed beneath it.
          The label has a small NEGATIVE left margin so its first letter
          sits slightly outside the badge's left edge — closer to where
          the agent NAME visually anchors on the rows below. The status
          badge is left untouched at the column's left edge so the
          status indicator's absolute position is unchanged. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p
          className="truncate text-[12px] font-medium leading-tight text-text"
          style={{ fontFamily: 'var(--font-body)', marginLeft: -8 }}
        >
          Group Chat
        </p>
        <div className="flex items-center">
          <StatusBadge status={aggregateStatus} />
        </div>
      </div>
    </button>
  )
}

// ─── AgentListColumn ─────────────────────────────────────────────────────────

export function AgentListColumn() {
  const agents = useFleetStore((s) => s.agents)
  const selectAgent = useFleetStore((s) => s.selectAgent)
  const hydrateAgents = useFleetStore((s) => s.hydrateAgents)

  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)
  const selectedTeam = useTeamStore((s) =>
    s.selectedTeamId ? (s.teams.find((t) => t.id === s.selectedTeamId) ?? null) : null,
  )

  const connectionStatus = useConnectionStore((s) => s.status)
  const client = useConnectionStore((s) => s.client)

  const viewMode = useViewStore((s) => s.viewMode)
  const pendingApprovals = useApprovalsStore((s) => s.pendingApprovals)

  const [query, setQuery] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)

  // Tick counter for "seen X ago" labels
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  // Delayed empty state
  const [showEmpty, setShowEmpty] = useState(false)
  const isEmptyConnected = agents.length === 0 && connectionStatus === 'connected' && !query
  useEffect(() => {
    if (!isEmptyConnected) {
      setShowEmpty(false)
      return
    }
    const timer = setTimeout(() => setShowEmpty(true), 1000)
    return () => clearTimeout(timer)
  }, [isEmptyConnected])

  // Filter agents by team + search query
  const filtered = useMemo(() => {
    let list = agents
    if (selectedTeamId !== null) {
      list = list.filter((a) => a.teamId === selectedTeamId)
    }
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter((a) => a.name.toLowerCase().includes(q))
    }
    return list
  }, [agents, selectedTeamId, query])

  const handleSelectAgent = useCallback(
    (agentId: string) => {
      selectAgent(agentId)
      useViewStore.getState().openAgent(agentId)
    },
    [selectAgent],
  )

  const handleBooCreated = useCallback(
    async (agentId?: string) => {
      if (!client) return
      try {
        const result = await client.agents.list()
        const mainKey = result.mainKey?.trim() || 'main'
        // Build lookups of existing assignments so we don't wipe them
        const existing = useFleetStore.getState().agents
        const existingTeamIds = new Map(existing.map((a) => [a.id, a.teamId]))
        const existingExecConfigs = new Map(existing.map((a) => [a.id, a.execConfig]))
        const mapped = result.agents.map((a) => ({
          id: a.id,
          name: a.identity?.name ?? a.name ?? a.id,
          status: 'idle' as const,
          sessionKey: `agent:${a.id}:${mainKey}`,
          model: null,
          createdAt: null,
          streamingText: null,
          runId: null,
          lastSeenAt: null,
          teamId:
            agentId && a.id === agentId && selectedTeamId
              ? selectedTeamId
              : (existingTeamIds.get(a.id) ?? null),
          execConfig: existingExecConfigs.get(a.id) ?? null,
        }))
        hydrateAgents(mapped)
        useBooZeroStore.getState().setBooZeroAgentId(identifyBooZero(mapped, result.defaultId))
      } catch {
        // hydration failure is non-fatal
      }
    },
    [client, hydrateAgents, selectedTeamId],
  )

  return (
    <div
      className="flex h-full flex-col border-r border-border bg-surface"
      style={{ width: 208, flexShrink: 0 }}
      data-testid="agent-list-column"
    >
      {/* Team header */}
      <div className="flex items-center justify-between px-3 pb-2 pt-4">
        <h2
          className="text-[11px] font-semibold uppercase tracking-widest text-secondary"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {selectedTeam ? selectedTeam.name : 'All Agents'}
          {filtered.length > 0 && (
            <span className="ml-1.5 tabular-nums text-secondary/60">({filtered.length})</span>
          )}
        </h2>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <label className="flex items-center gap-2 rounded-md border border-white/8 bg-surface px-2.5 py-1.5 focus-within:border-white/20 focus-within:ring-1 focus-within:ring-ring/30">
          <Search className="h-3.5 w-3.5 shrink-0 text-secondary" strokeWidth={2} />
          <input
            type="search"
            placeholder="Search agents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-text outline-none placeholder:text-secondary/50"
            style={{ fontFamily: 'var(--font-body)' }}
          />
        </label>
      </div>

      {/* Agent list — grows to fill the space between search and the
          global-nav block at the bottom. Scrolls when content overflows.
          The previous `height: 40%` was a fixed sliver that left awkward
          empty space mid-column and put the global nav adrift; using
          `flex-1` instead anchors it to a clear top-half, with Create Boo
          and the global nav (Atlas, Marketplace, Approvals, etc.) all
          sitting at the bottom edge. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {selectedTeam && filtered.length > 0 && (
          <>
            <GroupChatRow
              team={selectedTeam}
              teamAgents={filtered}
              isActive={viewMode.type === 'groupChat' && viewMode.teamId === selectedTeam.id}
              onClick={() => useViewStore.getState().openGroupChat(selectedTeam.id)}
            />
            <div className="mx-2.5 my-1 border-t border-white/6" />
          </>
        )}
        <AnimatePresence initial={false}>
          {filtered.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="px-3 py-6 text-center"
            >
              {query ? (
                <p className="text-[12px] text-secondary/50">No agents match.</p>
              ) : showEmpty ? (
                <div className="flex flex-col items-center gap-2">
                  <span className="text-2xl">👻</span>
                  <p className="text-[12px] text-secondary/50">No Boos yet</p>
                  <button
                    type="button"
                    onClick={() => useViewStore.getState().navigateTo('graph')}
                    className="text-[12px] font-medium text-accent transition-colors hover:text-accent/80"
                  >
                    Deploy a team →
                  </button>
                </div>
              ) : (
                <p className="text-[12px] text-secondary/50">No agents connected.</p>
              )}
            </motion.div>
          ) : (
            <motion.div key="list" exit={{ opacity: 0 }} className="flex flex-col gap-0.5">
              {filtered.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  // Highlight only when actually viewing this agent's
                  // detail page. Reading from `viewMode` (instead of
                  // `selectedAgentId`) ensures the row drops its
                  // highlight as soon as the user navigates to Group
                  // Chat / a nav view — the previously-selected agent
                  // shouldn't keep looking active when something else
                  // is on screen.
                  selected={viewMode.type === 'agent' && viewMode.agentId === agent.id}
                  onSelect={() => handleSelectAgent(agent.id)}
                  onDelete={() => {
                    if (!client) return
                    if (!window.confirm(`Delete ${agent.name}? This cannot be undone.`)) return
                    deleteAgentOperation(agent.id, agent.sessionKey, client).catch((err) => {
                      alert(
                        `Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`,
                      )
                    })
                  }}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Create Boo */}
      {client && (
        <div className="px-2">
          <button
            type="button"
            data-testid="fleet-create-boo"
            onClick={() => setShowCreateModal(true)}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-white/12 px-2 py-1.5 text-[11px] font-medium text-secondary/60 transition-colors hover:border-accent/30 hover:text-accent/60"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            Create Boo
          </button>
        </div>
      )}

      {/* Divider between Create Boo and nav */}
      <div className="mx-3 my-2 border-t border-white/6" />

      {/* Primary nav — Ghost Graph & Marketplace */}
      <div className="px-2 flex flex-col gap-0.5">
        {PRIMARY_NAV.map((item) => {
          const isActive = viewMode.type === 'nav' && viewMode.view === item.id
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => useViewStore.getState().navigateTo(item.id)}
              className={[
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] font-semibold transition-all duration-150',
                isActive
                  ? 'bg-accent/12 text-accent'
                  : 'text-secondary/50 hover:bg-white/4 hover:text-secondary/80',
              ].join(' ')}
            >
              <span className="text-[14px]">{item.emoji}</span>
              <span>{item.label}</span>
            </button>
          )
        })}
      </div>

      {/* Divider */}
      <div className="mx-3 my-1.5 border-t border-white/6" />

      {/* Secondary nav — Approvals, Scheduler, Cost */}
      <div className="px-2 pb-3 flex flex-col gap-0.5">
        {SECONDARY_NAV.map((item) => {
          const isActive = viewMode.type === 'nav' && viewMode.view === item.id
          const badge = item.id === 'approvals' ? pendingApprovals.size : 0
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => useViewStore.getState().navigateTo(item.id)}
              className={[
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-all duration-150',
                isActive
                  ? 'bg-accent/12 text-accent'
                  : 'text-secondary/40 hover:bg-white/4 hover:text-secondary/70',
              ].join(' ')}
            >
              <span className="text-[12px]">{item.emoji}</span>
              <span>{item.label}</span>
              {badge > 0 && (
                <span className="ml-auto rounded-full bg-amber px-1.5 py-px text-[9px] font-bold leading-snug text-background">
                  {badge}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <CreateBooModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={(agentId) => void handleBooCreated(agentId)}
      />
    </div>
  )
}
