import { motion } from 'framer-motion'
import { useMemo } from 'react'
import { BooAvatar } from '@clawboo/ui'
import type { AgentCatalogEntry } from '@/features/teams/types'
import { Button } from '@/features/shared/Button'
import { SOURCE_META, TEMPLATE_CATEGORIES, teamsContainingAgent } from './teamCatalog'

// ─── Helpers ────────────────────────────────────────────────────────────────────

function getCategoryLabel(category: string): string {
  const entry = TEMPLATE_CATEGORIES.find((c) => c.key === category)
  return entry?.label ?? category
}

function formatDomain(domain: string): string {
  // 'game-development' → 'Game Dev', 'project-management' → 'Project Mgmt'
  const special: Record<string, string> = {
    'game-development': 'Game Dev',
    'project-management': 'Project Mgmt',
    'spatial-computing': 'Spatial',
    'paid-media': 'Paid Media',
    openclaw: 'OpenClaw',
    clawboo: 'Clawboo',
  }
  if (special[domain]) return special[domain]
  return domain.charAt(0).toUpperCase() + domain.slice(1)
}

// ─── AgentCard ──────────────────────────────────────────────────────────────────

interface AgentCardProps {
  agent: AgentCatalogEntry
  index: number
  onDetails: (agent: AgentCatalogEntry) => void
  onDeploy: (agent: AgentCatalogEntry) => void
}

export function AgentCard({ agent, index, onDetails, onDeploy }: AgentCardProps) {
  const sourceMeta = SOURCE_META[agent.source]
  const teamCount = useMemo(() => teamsContainingAgent(agent.id).length, [agent.id])
  const skillCount = agent.skillIds.length

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay: Math.min(index * 0.02, 0.4) }}
      className="group flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-border-strong"
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      {/* Top row: avatar + name + role */}
      <div className="flex items-center gap-3">
        <div className="shrink-0">
          <BooAvatar seed={agent.name} size={40} />
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[14px] font-semibold text-foreground"
            style={{ letterSpacing: '-0.01em' }}
          >
            {agent.name}
          </div>
          <div className="truncate text-[12px] text-foreground/50">{agent.role}</div>
        </div>
      </div>

      {/* Badge row: source + domain + category */}
      <div className="flex flex-wrap items-center gap-1.5">
        {sourceMeta && (
          <span
            className="whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase"
            style={{
              color: sourceMeta.color,
              background: `${sourceMeta.color}18`,
              borderColor: `${sourceMeta.color}35`,
              letterSpacing: '0.03em',
            }}
          >
            {sourceMeta.label}
          </span>
        )}
        <span
          className="whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[9px] font-medium uppercase"
          style={{
            color: `${agent.color}cc`,
            background: `${agent.color}14`,
            borderColor: `${agent.color}30`,
            letterSpacing: '0.03em',
          }}
        >
          {formatDomain(agent.domain)}
        </span>
        <span className="text-[10px] text-foreground/35">{getCategoryLabel(agent.category)}</span>
      </div>

      {/* Description */}
      <div
        className="text-[12.5px] text-foreground/55"
        style={{
          lineHeight: 1.5,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {agent.description}
      </div>

      {/* Stats row */}
      <div className="font-data flex gap-2.5 text-[11px] text-foreground/40">
        <span>
          {skillCount} skill{skillCount === 1 ? '' : 's'}
        </span>
        <span className="text-foreground/25">•</span>
        <span>
          in {teamCount} team{teamCount === 1 ? '' : 's'}
        </span>
      </div>

      {/* Button row */}
      <div className="mt-0.5 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => onDetails(agent)}>
          Details
        </Button>
        <Button variant="primary" size="sm" onClick={() => onDeploy(agent)}>
          Deploy
        </Button>
      </div>
    </motion.div>
  )
}
