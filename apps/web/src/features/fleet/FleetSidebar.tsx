import { useState, useMemo, useEffect, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, ChevronRight, FileEdit, Plus, Search, Trash2 } from 'lucide-react'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'
import { useViewStore } from '@/stores/view'
import { PersonalitySliders } from '@/features/settings/PersonalitySliders'
import { CreateBooModal } from './CreateBooModal'
import { deleteAgentOperation } from './deleteAgentOperation'
import { useEditorStore } from '@/stores/editor'
import type { AgentStatus } from '@clawboo/gateway-client'

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatLastSeen(lastSeenAt: number | null): string | null {
  if (!lastSeenAt) return null
  const diff = Date.now() - lastSeenAt
  if (diff < 60_000) return 'seen just now'
  if (diff < 3_600_000) return `seen ${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `seen ${Math.floor(diff / 3_600_000)}h ago`
  return `seen ${Math.floor(diff / 86_400_000)}d ago`
}

// ─── Agent avatar ──────────────────────────────────────────────────────────────
// Wraps BooAvatar with a subtle selection ring.

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
      <AgentBooAvatar agentId={agent.id} size={36} />
    </span>
  )
}

// ─── Status badge ─────────────────────────────────────────────────────────────

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
        {/* pulsing dot */}
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

// ─── Agent row ────────────────────────────────────────────────────────────────

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
        'group flex w-full items-center gap-3 rounded-lg px-3 py-2.5',
        'transition-colors duration-150',
        selected ? 'bg-white/6 shadow-sm' : 'hover:bg-white/4',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <AgentAvatar agent={agent} selected={selected} />
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-[13px] font-medium leading-tight text-text"
            style={{ fontFamily: 'var(--font-body)' }}
          >
            {agent.name}
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <StatusBadge status={agent.status} />
            {agent.status !== 'running' && formatLastSeen(agent.lastSeenAt) && (
              <span className="text-[10px] text-secondary/40">
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
        <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </motion.div>
  )
}

// ─── Fleet sidebar ────────────────────────────────────────────────────────────

export function FleetSidebar() {
  const agents = useFleetStore((s) => s.agents)
  const selectedAgentId = useFleetStore((s) => s.selectedAgentId)
  const selectAgent = useFleetStore((s) => s.selectAgent)
  const hydrateAgents = useFleetStore((s) => s.hydrateAgents)

  const connectionStatus = useConnectionStore((s) => s.status)
  const client = useConnectionStore((s) => s.client)

  const [query, setQuery] = useState('')
  const [personalityOpen, setPersonalityOpen] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)

  // Tick counter to re-render "seen X ago" labels every 30s
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  const handleBooCreated = useCallback(async () => {
    if (!client) return
    try {
      const result = await client.agents.list()
      const mainKey = result.mainKey?.trim() || 'main'
      hydrateAgents(
        result.agents.map((a) => ({
          id: a.id,
          name: a.identity?.name ?? a.name ?? a.id,
          status: 'idle' as const,
          sessionKey: `agent:${a.id}:${mainKey}`,
          model: null,
          createdAt: null,
          streamingText: null,
          runId: null,
          lastSeenAt: null,
          teamId: null,
        })),
      )
    } catch {
      // hydration failure is non-fatal — fleet will catch up on next event
    }
  }, [client, hydrateAgents])

  // Delayed empty state — only show after 1s to avoid flash during hydration
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return agents
    return agents.filter((a) => a.name.toLowerCase().includes(q))
  }, [agents, query])

  return (
    <div className="flex h-full flex-col" data-testid="fleet-sidebar">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <h2
          className="text-[11px] font-semibold uppercase tracking-widest text-secondary"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          Fleet
          {agents.length > 0 && (
            <span className="ml-1.5 tabular-nums text-secondary/60">({agents.length})</span>
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

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
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
            <motion.div key="list" className="flex flex-col gap-0.5">
              {filtered.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  selected={agent.id === selectedAgentId}
                  onSelect={() => selectAgent(agent.id)}
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

      {/* Edit files — shown when an agent is selected */}
      {selectedAgentId && client && (
        <div className="border-t border-white/8 px-4 py-2">
          <button
            type="button"
            onClick={() => {
              const agent = agents.find((a) => a.id === selectedAgentId)
              if (agent) useEditorStore.getState().openEditor(agent.id, agent.name)
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[12px] font-medium text-secondary/70 transition-colors hover:bg-white/4 hover:text-text"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            <FileEdit className="h-3.5 w-3.5" strokeWidth={2} />
            Edit files
          </button>
        </div>
      )}

      {/* Personality settings — shown when an agent is selected */}
      {selectedAgentId && (
        <div className="border-t border-white/8">
          {/* Collapsible header */}
          <button
            type="button"
            onClick={() => setPersonalityOpen((o) => !o)}
            className="flex w-full items-center justify-between px-4 py-2.5 text-left transition-colors hover:bg-white/4"
          >
            <span
              className="text-[10px] font-semibold uppercase tracking-widest text-secondary"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              Personality
            </span>
            {personalityOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-secondary/60" strokeWidth={2} />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-secondary/60" strokeWidth={2} />
            )}
          </button>

          {/* Scrollable sliders panel */}
          {personalityOpen && (
            <div className="max-h-72 overflow-y-auto px-4 pb-3">
              <PersonalitySliders key={selectedAgentId} />
            </div>
          )}
        </div>
      )}

      {/* Create Boo */}
      {client && (
        <div className="border-t border-white/8 p-3">
          <button
            type="button"
            data-testid="fleet-create-boo"
            onClick={() => setShowCreateModal(true)}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-white/12 px-3 py-2 text-[12px] font-medium text-secondary/60 transition-colors hover:border-accent/30 hover:text-accent/60"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            Create Boo
          </button>
        </div>
      )}

      <CreateBooModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={() => void handleBooCreated()}
      />
    </div>
  )
}
