import { listAgents } from '@clawboo/control-client'
import { agentRecordToFleetState } from '@/lib/agentSourceClient'
import { useState, useMemo, useEffect, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ChevronRight,
  Gauge,
  Ghost,
  Globe,
  KanbanSquare,
  Plus,
  Settings,
  ShoppingCart,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { EmptyState } from '@/features/shared/EmptyState'
import { SearchInput } from '@/features/shared/SearchInput'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useTeamStore, type Team } from '@/stores/team'
import { useConnectionStore } from '@/stores/connection'
import { useViewStore, type NavView } from '@/stores/view'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { CreateBooModal } from '@/features/fleet/CreateBooModal'
import { deleteAgentOperation } from '@/features/fleet/deleteAgentOperation'
import { useToastStore } from '@/stores/toast'
import { confirm } from '@/stores/confirm'
import { useBooZeroStore, identifyBooZero } from '@/stores/booZero'
import { isHiddenGatewayDefault } from '@/lib/hiddenSystemAgent'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { aggregateTeamStatus } from '@/lib/teamStatus'
import { getActivityVerb } from '@/lib/agentActivityVerb'
import { useChatStore } from '@/stores/chat'
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
      className="inline-flex shrink-0 rounded-lg bg-background transition-all duration-200"
      style={{
        boxShadow: selected
          ? '0 0 0 2px rgb(var(--primary-rgb) / 0.55)'
          : '0 0 0 1.5px var(--border)',
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
    badge: 'bg-surface text-secondary border border-border',
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
    badge: 'bg-surface text-secondary/50 border border-border',
    pulse: false,
  },
}

function StatusBadge({ status, label }: { status: AgentStatus; label?: string }) {
  const cfg = STATUS_CONFIG[status]
  // `label` (when provided) is the fine-grained activity verb that
  // describes WHAT the agent is doing ("Streaming reply", "Delegating to @X",
  // "Just done"), replacing the coarse default ("Working", "Idle"). The dot
  // colour + pulse still derive from the underlying status so the visual
  // status semantics don't change.
  const display = label ?? cfg.label
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={`${status}|${display}`}
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.85 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide ${cfg.badge}`}
        title={display}
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
        {display}
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
  // Compute the live activity verb. Subscribe to the chat-store
  // maps via single-value selectors keyed by sessionKey so unrelated agents'
  // streams don't trigger this row's re-render (same precedent as
  // BooLiveActivity.tsx and chatComponents.tsx token-count selectors).
  const sk = agent.sessionKey
  const streamingText = useChatStore((s) => (sk ? (s.streamingText.get(sk) ?? null) : null))
  const transcripts = useChatStore((s) => s.transcripts)
  const verb = getActivityVerb({
    agent,
    transcripts,
    streamingTexts: sk ? new Map([[sk, streamingText ?? '']]) : null,
  })
  return (
    <motion.div
      layout
      data-testid={`fleet-agent-row-${agent.id}`}
      className={[
        'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2',
        'transition-colors duration-150',
        selected ? 'bg-foreground/[0.06] shadow-sm' : 'hover:bg-foreground/[0.04]',
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
            <StatusBadge status={agent.status} label={verb} />
            {agent.status !== 'running' &&
              verb !== 'Just done' &&
              formatLastSeen(agent.lastSeenAt) && (
                <span className="text-[9px] tabular-nums text-secondary/40">
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

interface NavItem {
  id: NavView
  label: string
  icon: LucideIcon
  /** Optional smaller, dimmer hint rendered beside the main label. */
  subtitle?: string
}

const PRIMARY_NAV: NavItem[] = [
  // `'graph'` opens Atlas — the global all-teams view with Boo Zero at
  // the top of the hierarchy. Renamed from "Ghost Graph" because the
  // team-scoped Ghost Graph still lives inside Group Chat; this slot is
  // now specifically the org-wide map. Subtitle clarifies that Atlas is
  // cross-team (vs. the per-team Ghost Graph users see inside Group Chat).
  { id: 'graph', label: 'Atlas', icon: Globe, subtitle: '(All Teams)' },
  { id: 'board', label: 'Board', icon: KanbanSquare },
  { id: 'marketplace', label: 'Marketplace', icon: ShoppingCart },
]

// Second nav block: Fleet + the Settings gear (rendered after this list). Settings
// opens the modal that houses the management / config / insights surfaces (Runtimes,
// Memory, Capabilities, Scheduler, Tokens Used, Observability, Governance, System,
// System Health) so the sidebar stays short.
// Approvals moved into the Board (a collapsible "Needs approval" column) + inline
// above the chat composer, so the sidebar no longer carries a separate item.
const SECONDARY_NAV: NavItem[] = [
  { id: 'fleet', label: 'Fleet', icon: Gauge, subtitle: '(Overview)' },
]

// One consistent nav row — neutral active surface + a brand-red active icon
// (the premium sidebar pattern). Used for both nav sections.
function NavButton({
  item,
  active,
  badge,
  onClick,
}: {
  item: NavItem
  active: boolean
  badge?: number
  onClick: () => void
}) {
  const Icon = item.icon
  return (
    <button
      type="button"
      data-testid={`nav-${item.id}`}
      onClick={onClick}
      className={[
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors duration-150 cursor-pointer',
        active
          ? 'bg-foreground/[0.06] font-semibold text-foreground'
          : 'font-medium text-foreground/60 hover:bg-foreground/[0.035] hover:text-foreground/90',
      ].join(' ')}
    >
      <Icon
        size={17}
        strokeWidth={2}
        aria-hidden
        style={{ color: active ? 'var(--primary)' : 'rgb(var(--foreground-rgb) / 0.45)' }}
      />
      <span className="truncate">{item.label}</span>
      {item.subtitle ? (
        <span className="text-[11px] font-normal text-foreground/40">{item.subtitle}</span>
      ) : null}
      {badge ? (
        <span className="ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
          {badge}
        </span>
      ) : null}
    </button>
  )
}

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
  // Ring color reads from the live `--surface` CSS variable so it stays
  // invisible against the column background in both light and dark modes.
  const ringColor = 'var(--surface)'

  const aggregateStatus = aggregateTeamStatus(ordered)

  return (
    <button
      type="button"
      data-testid="group-chat-row"
      onClick={onClick}
      title={`${team.name} — Group Chat (${ordered.length} agent${ordered.length === 1 ? '' : 's'})`}
      className={[
        // A distinct bordered "entry" card (unlike the borderless agent
        // rows) so the Group Chat CTA reads as the obvious place to click
        // into the team. Active = a gentle brand-red tint + red border.
        'group flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left cursor-pointer',
        'transition-all duration-150',
        isActive
          ? 'border-primary/45 bg-primary/[0.07]'
          : 'border-border bg-foreground/[0.025] hover:border-border-strong hover:bg-foreground/[0.05]',
      ].join(' ')}
    >
      {/* Team photo — overlapping Boo avatars on the left. The stack fits
          its actual avatars (only one Group Chat row is ever visible at a
          time, so no cross-team alignment is needed) — this keeps the
          "Group Chat" label snug against the photo instead of leaving a
          gap sized for a full 4-avatar stack. */}
      <div className="flex shrink-0 items-center">
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
              boxShadow: 'var(--shadow-raised)',
              background: 'var(--background)',
            }}
          >
            <AgentBooAvatar agentId={agent.id} size={GROUP_CHAT_AVATAR_SIZE} />
          </div>
        ))}
        {overflow > 0 && (
          <div
            title={`${overflow} more ${overflow === 1 ? 'agent' : 'agents'}`}
            className="flex shrink-0 items-center justify-center bg-muted text-[11px] font-bold text-foreground/75"
            style={{
              marginLeft: -(GROUP_CHAT_AVATAR_SIZE - GROUP_CHAT_STRIDE),
              width: GROUP_CHAT_AVATAR_SIZE,
              height: GROUP_CHAT_AVATAR_SIZE,
              borderRadius: '50%',
              border: `2px solid ${ringColor}`,
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
          below, sitting right beside the team photo. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p
          className={[
            'truncate text-[12.5px] font-semibold leading-tight',
            isActive ? 'text-primary' : 'text-foreground',
          ].join(' ')}
        >
          Group Chat
        </p>
        <div className="flex items-center">
          <StatusBadge status={aggregateStatus} />
        </div>
      </div>

      {/* Trailing chevron — signals this row navigates INTO the team chat
          (a clear "click me" affordance distinct from the agent rows). */}
      <ChevronRight
        size={15}
        strokeWidth={2.25}
        className={[
          'shrink-0 transition-transform duration-150 group-hover:translate-x-0.5',
          isActive ? 'text-primary' : 'text-foreground/35',
        ].join(' ')}
      />
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
  // The identified Boo Zero + the OpenClaw Gateway's own default agent — used to
  // hide the Gateway "main" system agent from the sidebar (see isHiddenGatewayDefault).
  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)
  const gatewayMainAgentId = useBooZeroStore((s) => s.gatewayMainAgentId)

  const connectionStatus = useConnectionStore((s) => s.status)
  const client = useConnectionStore((s) => s.client)

  const viewMode = useViewStore((s) => s.viewMode)
  const settingsOpen = useSettingsModalStore((s) => s.open)

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
    // Hide the OpenClaw Gateway default ("main") when it isn't the identified Boo
    // Zero — a teamless system agent, not a user team member.
    let list = agents.filter((a) => !isHiddenGatewayDefault(a, gatewayMainAgentId, booZeroAgentId))
    if (selectedTeamId !== null) {
      list = list.filter((a) => a.teamId === selectedTeamId)
    }
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter((a) => a.name.toLowerCase().includes(q))
    }
    return list
  }, [agents, selectedTeamId, query, gatewayMainAgentId, booZeroAgentId])

  const handleSelectAgent = useCallback(
    (agentId: string) => {
      selectAgent(agentId)
      useViewStore.getState().openAgent(agentId)
    },
    [selectAgent],
  )

  const handleBooCreated = useCallback(
    async (agentId?: string) => {
      try {
        const { defaultId, agents: records } = await listAgents()
        // Merge live store state so the refresh doesn't clobber running agents.
        const existing = new Map(useFleetStore.getState().agents.map((a) => [a.id, a]))
        const mapped = records.map((r) => {
          const base = agentRecordToFleetState(r)
          const prev = existing.get(r.id)
          const merged = prev
            ? {
                ...base,
                status: prev.status,
                model: prev.model,
                streamingText: prev.streamingText,
                runId: prev.runId,
                lastSeenAt: prev.lastSeenAt,
              }
            : base
          // The just-created agent may not have its team assignment synced yet —
          // overlay the selected team optimistically.
          if (agentId && r.id === agentId && selectedTeamId) merged.teamId = selectedTeamId
          return merged
        })
        hydrateAgents(mapped)
        useBooZeroStore.getState().setBooZeroAgentId(identifyBooZero(mapped, defaultId))
      } catch {
        // hydration failure is non-fatal
      }
    },
    [hydrateAgents, selectedTeamId],
  )

  return (
    <div
      className="flex h-full flex-col border-r border-border bg-surface"
      style={{ width: 236, flexShrink: 0 }}
      data-testid="agent-list-column"
    >
      {/* Team header */}
      <div className="flex items-center justify-between px-3.5 pb-2.5 pt-4">
        <h2 className="truncate font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/45">
          {selectedTeam ? selectedTeam.name : 'All Agents'}
          {filtered.length > 0 && (
            <span className="ml-1.5 tabular-nums text-foreground/30">{filtered.length}</span>
          )}
        </h2>
      </div>

      {/* Search */}
      <div className="px-3 pb-2.5">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search agents…"
          size="sm"
          aria-label="Search agents"
        />
      </div>

      {/* Agent list — grows to fill the space between search and the
          global-nav block at the bottom. Scrolls when content overflows.
          The previous `height: 40%` was a fixed sliver that left awkward
          empty space mid-column and put the global nav adrift; using
          `flex-1` instead anchors it to a clear top-half, with Create Boo
          and the global nav (Atlas, Marketplace, Approvals, etc.) all
          sitting at the bottom edge. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2" data-testid="fleet-agent-list">
        {selectedTeam && filtered.length > 0 && (
          <>
            <GroupChatRow
              team={selectedTeam}
              teamAgents={filtered}
              isActive={viewMode.type === 'groupChat' && viewMode.teamId === selectedTeam.id}
              onClick={() => useViewStore.getState().openGroupChat(selectedTeam.id)}
            />
            <div className="mx-2.5 my-1 border-t border-border" />
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
                <EmptyState
                  icon={Ghost}
                  title="No Boos yet"
                  helper="Deploy a team from the Marketplace to get started."
                  paddingTop={16}
                  action={
                    <button
                      type="button"
                      onClick={() => useViewStore.getState().navigateTo('graph')}
                      className="text-[12px] font-medium text-accent transition-colors hover:text-accent/80"
                    >
                      Deploy a team →
                    </button>
                  }
                />
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
                    void (async () => {
                      if (
                        !(await confirm({
                          title: `Delete ${agent.name}?`,
                          message: 'This cannot be undone.',
                          confirmLabel: 'Delete',
                          tone: 'danger',
                        }))
                      )
                        return
                      try {
                        await deleteAgentOperation(agent.id, agent.sessionKey)
                      } catch (err) {
                        useToastStore.getState().addToast({
                          type: 'error',
                          message: `Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`,
                        })
                      }
                    })()
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
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border px-2 py-1.5 text-[11px] font-medium text-secondary/60 transition-colors hover:border-accent/40 hover:text-accent/70"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            Create Boo
          </button>
        </div>
      )}

      {/* Divider between Create Boo and nav */}
      <div className="mx-3 my-2 border-t border-border" />

      {/* Primary nav */}
      <div className="flex flex-col gap-0.5 px-2">
        {PRIMARY_NAV.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={viewMode.type === 'nav' && viewMode.view === item.id}
            onClick={() => useViewStore.getState().navigateTo(item.id)}
          />
        ))}
      </div>

      {/* Divider */}
      <div className="mx-3 my-1.5 border-t border-border" />

      {/* Second nav block: Fleet + Settings (Settings opens the modal that houses
          the management / config / insights surfaces). */}
      <div className="flex flex-col gap-0.5 px-2">
        {SECONDARY_NAV.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={viewMode.type === 'nav' && viewMode.view === item.id}
            badge={0}
            onClick={() => useViewStore.getState().navigateTo(item.id)}
          />
        ))}
        <button
          type="button"
          data-testid="nav-settings"
          onClick={() => useSettingsModalStore.getState().openSettings()}
          title="Settings (⌘,)"
          className={[
            'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors duration-150 cursor-pointer',
            settingsOpen
              ? 'bg-foreground/[0.06] font-semibold text-foreground'
              : 'font-medium text-foreground/60 hover:bg-foreground/[0.035] hover:text-foreground/90',
          ].join(' ')}
        >
          <Settings
            size={17}
            strokeWidth={2}
            aria-hidden
            style={{ color: settingsOpen ? 'var(--primary)' : 'rgb(var(--foreground-rgb) / 0.45)' }}
          />
          <span className="truncate">Settings</span>
        </button>
      </div>

      {/* Footer — theme toggle. The GitHub Star CTA lives in the top bar, so the
          footer is reserved for the theme preference. */}
      <div className="mx-3 my-1.5 border-t border-border" />
      <div className="flex flex-col gap-0.5 px-2 pb-3">
        <ThemeToggle />
      </div>

      <CreateBooModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={(agentId) => void handleBooCreated(agentId)}
      />
    </div>
  )
}
