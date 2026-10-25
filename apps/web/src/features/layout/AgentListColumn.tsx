import { listAgents } from '@clawboo/control-client'
import { agentRecordToFleetState } from '@/lib/agentSourceClient'
import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Brain,
  Ghost,
  Home,
  KanbanSquare,
  MoreHorizontal,
  Network,
  Pin,
  Plus,
  Settings,
  Plug,
  Search,
  ShoppingCart,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { GroupAvatar } from '@/components/GroupAvatar'
import { SidebarToggle } from '@/features/layout/SidebarToggle'
import { EmptyState } from '@/features/shared/EmptyState'
import { SearchInput } from '@/features/shared/SearchInput'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useTeamStore, type Team } from '@/stores/team'
import { isSessionLive, useConnectionStore } from '@/stores/connection'
import { useViewStore, type NavView } from '@/stores/view'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { CreateBooModal } from '@/features/fleet/CreateBooModal'
import { deleteAgentOperation } from '@/features/fleet/deleteAgentOperation'
import { useToastStore } from '@/stores/toast'
import { confirm } from '@/stores/confirm'
import { useBooZeroStore, identifyBooZero, isBooZeroEligibleForTeam } from '@/stores/booZero'
import { isHiddenGatewayDefault } from '@/lib/hiddenSystemAgent'
import { NAV_VIEW_LABELS } from '@/lib/navLabels'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { getActivityVerb } from '@/lib/agentActivityVerb'
import { useVisiblePolling } from '@/lib/useVisiblePolling'
import { useChatStore } from '@/stores/chat'
import { useRoomStore, useTeamRooms, type Room } from '@/stores/rooms'
import { RoomDialog } from '@/features/group-chat/RoomDialog'
import { RoomActionsMenu } from '@/features/group-chat/RoomActionsMenu'
import { DEFAULT_ROOM_NAME, updateRoom } from '@/lib/roomsClient'
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
      className="inline-flex shrink-0 rounded-lg bg-background transition-[box-shadow] duration-200"
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
  /** Absent for an agent that can't be deleted from here (Boo Zero). */
  onDelete?: () => void
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
            className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium leading-tight text-text"
            style={{ fontFamily: 'var(--font-body)' }}
          >
            <span className="truncate">{agent.name}</span>
          </p>
          <div className="mt-1 flex items-center gap-2">
            <StatusBadge status={agent.status} label={verb} />
            {agent.status !== 'running' &&
              verb !== 'Just done' &&
              formatLastSeen(agent.lastSeenAt) && (
                <span className="text-[9px] tabular-nums text-muted-foreground">
                  {formatLastSeen(agent.lastSeenAt)}
                </span>
              )}
          </div>
        </div>
      </button>

      {onDelete && (
        <button
          type="button"
          aria-label={`Delete ${agent.name}`}
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          // See FleetSidebar's twin: revealing the icon is not enough on its own,
          // `text-secondary/40` stays under the contrast floor once focused.
          className="shrink-0 rounded p-1 text-secondary/40 opacity-0 transition-all hover:text-destructive focus-visible:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash2 className="h-3 w-3" strokeWidth={2} />
        </button>
      )}
    </motion.div>
  )
}

// ─── Nav items ───────────────────────────────────────────────────────────────

// Labels come from `lib/navLabels.ts` (the single source of truth shared with the
// Settings modal and with error-boundary failure copy), so an item is just an id
// + its icon and optional subtitle.
interface NavItem {
  id: NavView
  icon: LucideIcon
  /** Optional smaller, dimmer hint rendered beside the main label. */
  subtitle?: string
}

// The sidebar's nav, in order (the team's Home sits above it when a team is open, and
// Settings below it). Settings opens the modal that houses the management /
// config / insights surfaces (Providers, Runtimes, Fleet, Capabilities, Routines,
// Tokens Used, Observability, Governance, System, System Health). Memory is
// DELIBERATELY in both places: here as the graph + list, in the modal as a list
// (see stores/settingsModal.ts).
const NAV: NavItem[] = [
  // `'graph'` is the Org chart: every team, with Boo Zero at the top.
  { id: 'graph', icon: Network },
  { id: 'board', icon: KanbanSquare },
  // Its own destination rather than a Marketplace tab: connecting a tool the
  // agents will use is not the same errand as shopping for a team template.
  { id: 'connectors', icon: Plug },
  { id: 'memory', icon: Brain },
  { id: 'marketplace', icon: ShoppingCart },
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
      <span className="truncate">{NAV_VIEW_LABELS[item.id]}</span>
      {item.subtitle ? (
        <span className="text-[11px] font-normal text-muted-foreground">{item.subtitle}</span>
      ) : null}
      {badge ? (
        <span className="ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary-solid px-1 text-[10px] font-bold text-primary-foreground">
          {badge}
        </span>
      ) : null}
    </button>
  )
}

// ─── Home row + the team's mascots ───────────────────────────────────────────
//
// The Home row opens the team's dashboards and artifacts. The mascot grid shows
// every agent, named, wrapping onto more rows as the team grows (Boo Zero last).

const TEAMSPACE_MASCOT = 42

/** The team's Home (its dashboards and artifacts), styled like the nav rows. */
function TeamspaceButton({
  team,
  isActive,
  onClick,
}: {
  team: Team
  isActive: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid="teamspace-row"
      aria-current={isActive ? 'page' : undefined}
      onClick={onClick}
      title={`${team.name} Home: dashboards and artifacts`}
      className={[
        'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors duration-150',
        isActive
          ? 'bg-foreground/[0.06] font-semibold text-foreground'
          : 'font-medium text-foreground/60 hover:bg-foreground/[0.035] hover:text-foreground/90',
      ].join(' ')}
    >
      <Home
        size={17}
        strokeWidth={2}
        aria-hidden
        style={{ color: isActive ? 'var(--primary)' : 'rgb(var(--foreground-rgb) / 0.45)' }}
      />
      <span className="truncate">Home</span>
    </button>
  )
}

function MascotTile({
  agent,
  selected,
  onOpen,
}: {
  agent: AgentState
  selected: boolean
  onOpen: () => void
}) {
  const working = agent.status === 'running'
  const failed = agent.status === 'error'
  return (
    <button
      type="button"
      onClick={onOpen}
      title={agent.name}
      aria-current={selected ? 'page' : undefined}
      data-testid={`teamspace-mascot-${agent.id}`}
      className={[
        'group/mascot flex min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-xl px-0.5 pb-1.5 pt-2 transition-colors duration-150',
        selected ? 'bg-foreground/[0.06]' : 'hover:bg-foreground/[0.04]',
      ].join(' ')}
    >
      <span
        className="relative inline-flex transition-transform duration-150 group-hover/mascot:-translate-y-0.5"
        aria-hidden
      >
        <AgentBooAvatar agentId={agent.id} size={TEAMSPACE_MASCOT} />
        {(working || failed) && (
          <span
            className={[
              'absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full ring-2 ring-surface',
              working ? 'animate-pulse bg-mint' : 'bg-destructive',
            ].join(' ')}
          />
        )}
      </span>
      <span
        className={[
          'w-full truncate text-center text-[11px] leading-tight',
          selected
            ? 'font-semibold text-foreground'
            : 'text-muted-foreground group-hover/mascot:text-foreground',
        ].join(' ')}
      >
        {agent.name}
      </span>
    </button>
  )
}

// ─── Chat rooms (below the agent list) ───────────────────────────────────────
// A team's extra conversations, each with some of its members. Lighter than the
// Group Chat card: borderless, a small member stack and the room's name.

// The room's picture: its members' faces in one circle (see GroupAvatar).
const ROOM_AVATAR_SIZE = 32

/** Inline rename for a room row: Enter or leaving the field saves, Escape cancels. */
function RoomRenameInput({ room, onDone }: { room: Room; onDone: () => void }) {
  const [value, setValue] = useState(room.name)
  const ref = useRef<HTMLInputElement>(null)
  const finished = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const commit = async () => {
    if (finished.current) return
    finished.current = true
    onDone()
    const name = value.trim()
    if (!name || name === room.name) return
    const result = await updateRoom(room.teamId, room.id, { name })
    if (result.ok) useRoomStore.getState().upsert(result.room)
    else useToastStore.getState().addToast({ type: 'error', message: result.error })
  }

  return (
    <input
      ref={ref}
      value={value}
      maxLength={80}
      aria-label="Room name"
      data-testid="room-rename-input"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          void commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finished.current = true
          onDone()
        }
      }}
      className="min-w-0 flex-1 rounded-md border border-primary/50 bg-surface px-1.5 py-0.5 text-[12.5px] font-medium text-foreground outline-none"
    />
  )
}

function RoomRow({
  room,
  memberIds,
  isActive,
  onClick,
  fixed = false,
}: {
  room: Room
  /** The room's members still on the team (what the room's chat actually has). */
  memberIds: string[]
  isActive: boolean
  onClick: () => void
  /** The General room (the team's own chat): always pinned, and its only
   *  action is clearing the chat. */
  fixed?: boolean
}) {
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null)
  const [renaming, setRenaming] = useState(false)
  const pinned = fixed || room.pinnedAt != null
  // `--group-ring` matches the row's own background, so the group picture's
  // discs cut cleanly out of each other on a plain, hovered or selected row.
  const rowClass = [
    'flex w-full items-center gap-2.5 rounded-lg py-1.5 pl-2.5 pr-8 text-left',
    'transition-colors duration-150',
    isActive
      ? 'bg-primary/[0.07] [--group-ring:color-mix(in_oklab,var(--primary)_7%,var(--surface))]'
      : 'hover:bg-foreground/[0.05] [--group-ring:var(--surface)] hover:[--group-ring:color-mix(in_oklab,var(--foreground)_5%,var(--surface))]',
  ].join(' ')

  const avatars = <GroupAvatar agentIds={memberIds} size={ROOM_AVATAR_SIZE} />

  return (
    <div className="group relative">
      {renaming ? (
        <div className={rowClass}>
          {avatars}
          <RoomRenameInput room={room} onDone={() => setRenaming(false)} />
        </div>
      ) : (
        <button
          type="button"
          data-testid={fixed ? 'group-chat-row' : 'room-row'}
          aria-current={isActive ? 'page' : undefined}
          onClick={onClick}
          title={
            fixed
              ? `${room.name}: everyone on the team`
              : `${room.name} (${memberIds.length} member${memberIds.length === 1 ? '' : 's'})`
          }
          className={`${rowClass} cursor-pointer`}
        >
          {avatars}
          <span
            className={[
              'min-w-0 flex-1 truncate text-[12.5px]',
              isActive ? 'font-semibold text-primary' : 'font-medium text-foreground',
            ].join(' ')}
          >
            {room.name}
            {fixed && (
              <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                (Main Room)
              </span>
            )}
          </span>
        </button>
      )}
      {!renaming && (
        <>
          {/* Pinned rooms show a pin where the "..." button appears on hover. */}
          {pinned && !menuAnchor && (
            <Pin
              size={11}
              strokeWidth={2.25}
              aria-label="Pinned"
              className="pointer-events-none absolute right-2.5 top-1/2 -mt-[5.5px] text-muted-foreground transition-opacity duration-150 group-focus-within:opacity-0 group-hover:opacity-0"
            />
          )}
          <button
            type="button"
            aria-label={`More actions for ${room.name}`}
            aria-haspopup="menu"
            aria-expanded={menuAnchor != null}
            data-testid={fixed ? 'general-actions' : 'room-actions'}
            onClick={(e) => setMenuAnchor(e.currentTarget.getBoundingClientRect())}
            className={[
              'absolute right-1 top-1/2 -mt-3 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground',
              'transition-opacity duration-150 hover:bg-foreground/[0.08] hover:text-foreground',
              menuAnchor
                ? 'bg-foreground/[0.08] text-foreground opacity-100'
                : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100',
            ].join(' ')}
          >
            <MoreHorizontal size={15} strokeWidth={2} aria-hidden />
          </button>
        </>
      )}
      {menuAnchor && (
        <RoomActionsMenu
          room={room}
          anchor={menuAnchor}
          onClose={() => setMenuAnchor(null)}
          onRename={() => setRenaming(true)}
          general={fixed}
        />
      )}
    </div>
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
  const [searchOpen, setSearchOpen] = useState(false)
  const columnCollapsed = useViewStore((s) => s.columnCollapsed)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showRoomDialog, setShowRoomDialog] = useState(false)

  // The selected team's chat rooms, read when the team is selected.
  const rooms = useTeamRooms(selectedTeamId)
  // The team's own group chat, shown as the first room: always pinned, with
  // everyone on the team in it.
  const generalRoom = useMemo<Room | null>(() => {
    if (!selectedTeamId) return null
    return {
      id: '',
      teamId: selectedTeamId,
      name: DEFAULT_ROOM_NAME,
      memberIds: agents
        .filter(
          (a) =>
            a.teamId === selectedTeamId &&
            !isHiddenGatewayDefault(a, gatewayMainAgentId, booZeroAgentId),
        )
        .map((a) => a.id),
      pinnedAt: null,
      createdAt: 0,
      updatedAt: 0,
    }
  }, [agents, selectedTeamId, gatewayMainAgentId, booZeroAgentId])

  // Pinned rooms first (most recently pinned on top), then newest first.
  const orderedRooms = useMemo(
    () =>
      [...rooms].sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.createdAt - a.createdAt),
    [rooms],
  )
  useEffect(() => {
    if (selectedTeamId) void useRoomStore.getState().load(selectedTeamId)
  }, [selectedTeamId])

  // Tick counter for "seen X ago" labels — paused while the tab is hidden, with
  // one catch-up tick on return (same rationale as FleetSidebar).
  const [, setTick] = useState(0)
  useVisiblePolling(() => setTick((n) => n + 1), 30_000)

  // Delayed empty state
  const [showEmpty, setShowEmpty] = useState(false)
  // Live-session, not strictly 'connected': "we have a session and the fleet is
  // empty" stays true across a socket drop, so the delayed empty card should not
  // blink out and restart its 1s timer on every blip.
  const isEmptyConnected = agents.length === 0 && isSessionLive(connectionStatus) && !query
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

  // The team's members regardless of the search: the mascot grid, and
  // whether the team has anyone at all.
  const teamMembers = useMemo(
    () =>
      selectedTeamId
        ? agents.filter(
            (a) =>
              a.teamId === selectedTeamId &&
              !isHiddenGatewayDefault(a, gatewayMainAgentId, booZeroAgentId),
          )
        : [],
    [agents, selectedTeamId, gatewayMainAgentId, booZeroAgentId],
  )
  const hasTeam = selectedTeam != null && teamMembers.length > 0
  // The team's mascots, with Boo Zero (who leads every team) last. The search narrows them.
  const cardAgents = useMemo(() => {
    const bz = booZeroAgentId ? (agents.find((a) => a.id === booZeroAgentId) ?? null) : null
    const lead = bz && selectedTeamId && isBooZeroEligibleForTeam(bz, selectedTeamId) ? bz : null
    return lead ? [...teamMembers.filter((a) => a.id !== lead.id), lead] : teamMembers
  }, [agents, booZeroAgentId, selectedTeamId, teamMembers])
  const mascotAgents = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? cardAgents.filter((a) => a.name.toLowerCase().includes(q)) : cardAgents
  }, [cardAgents, query])
  const isViewingAgent = (agentId: string) =>
    (viewMode.type === 'agent' && viewMode.agentId === agentId) ||
    (viewMode.type === 'booZero' && agentId === booZeroAgentId)
  const deleteAgent = (agent: AgentState) => {
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
  }

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
    // Width, border and the drag handle belong to the sidebar shell (AppSidebar),
    // which lays this out at its natural width or wider and clips it when narrower.
    <div className="flex h-full w-full flex-col bg-surface" data-testid="agent-list-column">
      {/* Top row: the team's name, a search icon that opens into a field in this
          same row, and the sidebar toggle. */}
      <div className="flex h-11 shrink-0 items-center gap-1 pl-3.5 pr-2 pt-1.5">
        {searchOpen ? (
          <div
            className="min-w-0 flex-1"
            onBlur={(e) => {
              if (!query && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setSearchOpen(false)
              }
            }}
          >
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Search agents…"
              size="sm"
              variant="quiet"
              aria-label="Search agents"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  setQuery('')
                  setSearchOpen(false)
                }
              }}
            />
          </div>
        ) : (
          <>
            <h2 className="min-w-0 flex-1 truncate font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {selectedTeam ? selectedTeam.name : 'All Agents'}
            </h2>
            <button
              type="button"
              aria-label="Search agents"
              data-testid="agent-search-open"
              onClick={() => setSearchOpen(true)}
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground/45 transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground/80"
            >
              <Search size={16} strokeWidth={1.9} aria-hidden />
            </button>
          </>
        )}
        {/* In the hover peek of a collapsed sidebar the rail holds the toggle,
            right under the pointer that opened the peek. */}
        {!columnCollapsed && (
          <SidebarToggle
            collapsed={false}
            onClick={() => useViewStore.getState().setColumnCollapsed(true)}
          />
        )}
      </div>

      {/* Agent list — grows to fill the space between search and the
          global-nav block at the bottom. Scrolls when content overflows.
          The previous `height: 40%` was a fixed sliver that left awkward
          empty space mid-column and put the global nav adrift; using
          `flex-1` instead anchors it to a clear top-half, with Create Boo
          and the global nav (Atlas, Marketplace, Approvals, etc.) all
          sitting at the bottom edge. */}
      {/* The team's mascots stay put above the scrolling list. */}
      {hasTeam && selectedTeam && (
        <div className="px-2 pb-2">
          <div
            className="grid max-h-[36vh] gap-x-0.5 gap-y-1 overflow-y-auto"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(60px, 1fr))' }}
            data-testid="team-mascots"
          >
            {mascotAgents.map((agent) => (
              <MascotTile
                key={agent.id}
                agent={agent}
                selected={isViewingAgent(agent.id)}
                onOpen={() => handleSelectAgent(agent.id)}
              />
            ))}
          </div>
          {query && mascotAgents.length === 0 && (
            <p className="px-3 py-2 text-center text-[12px] text-secondary/50">No agents match.</p>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2" data-testid="fleet-agent-list">
        {/* No team selected: every agent, flat. A team with nobody in it yet: its empty state. */}
        {!hasTeam && (
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
                    onDelete={() => deleteAgent(agent)}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        )}
        {/* Rooms come after the 1:1 agents: the team's extra conversations,
            each with some of its members. */}
        {hasTeam && selectedTeam && (
          <>
            <div className="flex flex-col gap-0.5 pt-1" data-testid="room-list">
              <button
                type="button"
                data-testid="new-room-button"
                onClick={() => setShowRoomDialog(true)}
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg py-1.5 pl-3 pr-2 text-left text-[12px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.05] hover:text-foreground"
              >
                <Plus size={14} strokeWidth={2.25} aria-hidden />
                New room
              </button>
              {generalRoom && (
                <RoomRow
                  room={generalRoom}
                  memberIds={generalRoom.memberIds}
                  isActive={
                    viewMode.type === 'groupChat' &&
                    viewMode.teamId === selectedTeam.id &&
                    !viewMode.roomId
                  }
                  onClick={() => useViewStore.getState().openGroupChat(selectedTeam.id)}
                  fixed
                />
              )}
              {orderedRooms.map((room) => (
                <RoomRow
                  key={room.id}
                  room={room}
                  memberIds={room.memberIds.filter((id) =>
                    agents.some((a) => a.id === id && a.teamId === selectedTeam.id),
                  )}
                  isActive={
                    viewMode.type === 'groupChat' &&
                    viewMode.teamId === selectedTeam.id &&
                    viewMode.roomId === room.id
                  }
                  onClick={() => useViewStore.getState().openGroupChat(selectedTeam.id, room.id)}
                />
              ))}
            </div>
          </>
        )}
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

      {/* Nav: Home (when a team is open), the work surfaces, then Settings. */}
      <div className="flex flex-col gap-0.5 px-2">
        {hasTeam && selectedTeam && (
          <TeamspaceButton
            team={selectedTeam}
            isActive={viewMode.type === 'teamspace' && viewMode.teamId === selectedTeam.id}
            onClick={() => useViewStore.getState().openTeamspace(selectedTeam.id)}
          />
        )}
        {NAV.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={viewMode.type === 'nav' && viewMode.view === item.id}
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
      {selectedTeam && (
        <RoomDialog
          open={showRoomDialog}
          onClose={() => setShowRoomDialog(false)}
          teamId={selectedTeam.id}
        />
      )}
    </div>
  )
}
