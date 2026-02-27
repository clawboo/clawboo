'use client'

import { useState, useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, ChevronRight, Plus, Search } from 'lucide-react'
import { BooAvatar } from '@clawboo/ui'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { PersonalitySliders } from '@/features/settings/PersonalitySliders'
import type { AgentStatus } from '@clawboo/gateway-client'

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
      <BooAvatar seed={agent.id} size={36} />
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
}: {
  agent: AgentState
  selected: boolean
  onSelect: () => void
}) {
  return (
    <motion.button
      layout
      type="button"
      data-testid={`fleet-agent-row-${agent.id}`}
      onClick={onSelect}
      className={[
        'group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left',
        'transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        selected ? 'bg-white/6 shadow-sm' : 'hover:bg-white/4',
      ].join(' ')}
    >
      <AgentAvatar agent={agent} selected={selected} />

      <div className="min-w-0 flex-1">
        <p
          className="truncate text-[13px] font-medium leading-tight text-text"
          style={{ fontFamily: 'var(--font-body)' }}
        >
          {agent.name}
        </p>
        <div className="mt-1.5">
          <StatusBadge status={agent.status} />
        </div>
      </div>
    </motion.button>
  )
}

// ─── Fleet sidebar ────────────────────────────────────────────────────────────

export function FleetSidebar() {
  const agents = useFleetStore((s) => s.agents)
  const selectedAgentId = useFleetStore((s) => s.selectedAgentId)
  const selectAgent = useFleetStore((s) => s.selectAgent)

  const [query, setQuery] = useState('')
  const [personalityOpen, setPersonalityOpen] = useState(true)

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
            <motion.p
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="px-3 py-6 text-center text-[12px] text-secondary/50"
            >
              {query ? 'No agents match.' : 'No agents connected.'}
            </motion.p>
          ) : (
            <motion.div key="list" className="flex flex-col gap-0.5">
              {filtered.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  selected={agent.id === selectedAgentId}
                  onSelect={() => selectAgent(agent.id)}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

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
      <div className="border-t border-white/8 p-3">
        <button
          type="button"
          data-testid="fleet-create-boo"
          disabled
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-white/12 px-3 py-2 text-[12px] font-medium text-secondary/60 transition-colors hover:border-accent/30 hover:text-accent/60 disabled:cursor-not-allowed"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          Create Boo
        </button>
      </div>
    </div>
  )
}
