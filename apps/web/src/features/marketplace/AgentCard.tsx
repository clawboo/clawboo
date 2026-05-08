import { motion } from 'framer-motion'
import { useMemo } from 'react'
import { BooAvatar } from '@clawboo/ui'
import type { AgentCatalogEntry } from '@/features/teams/types'
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
      style={{
        background: '#111827',
        border: `1px solid ${agent.color}25`,
        borderRadius: 10,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = `${agent.color}45`
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = `${agent.color}25`
      }}
    >
      {/* Top row: avatar + name + role */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flexShrink: 0 }}>
          <BooAvatar seed={agent.name} size={40} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: '#E8E8E8',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {agent.name}
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'rgba(232,232,232,0.45)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {agent.role}
          </div>
        </div>
      </div>

      {/* Badge row: source + domain + category */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {sourceMeta && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 600,
              color: sourceMeta.color,
              background: `${sourceMeta.color}18`,
              border: `1px solid ${sourceMeta.color}35`,
              borderRadius: 4,
              padding: '1px 6px',
              whiteSpace: 'nowrap',
              letterSpacing: '0.03em',
            }}
          >
            {sourceMeta.label}
          </span>
        )}
        <span
          style={{
            fontSize: 9,
            fontWeight: 500,
            color: `${agent.color}cc`,
            background: `${agent.color}14`,
            border: `1px solid ${agent.color}30`,
            borderRadius: 4,
            padding: '1px 6px',
            whiteSpace: 'nowrap',
            letterSpacing: '0.03em',
          }}
        >
          {formatDomain(agent.domain)}
        </span>
        <span style={{ fontSize: 10, color: 'rgba(232,232,232,0.35)' }}>
          {getCategoryLabel(agent.category)}
        </span>
      </div>

      {/* Description */}
      <div
        style={{
          fontSize: 12,
          color: 'rgba(232,232,232,0.5)',
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
      <div
        style={{
          fontSize: 10.5,
          color: 'rgba(232,232,232,0.4)',
          display: 'flex',
          gap: 10,
        }}
      >
        <span>
          {skillCount} skill{skillCount === 1 ? '' : 's'}
        </span>
        <span>•</span>
        <span>
          in {teamCount} team{teamCount === 1 ? '' : 's'}
        </span>
      </div>

      {/* Button row */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 2 }}>
        <button
          onClick={() => onDetails(agent)}
          style={{
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.08)',
            color: 'rgba(232,232,232,0.55)',
            fontSize: 11,
            fontWeight: 500,
            padding: '4px 10px',
            borderRadius: 6,
            cursor: 'pointer',
            transition: 'all 0.15s',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)'
            e.currentTarget.style.color = 'rgba(232,232,232,0.75)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
            e.currentTarget.style.color = 'rgba(232,232,232,0.55)'
          }}
        >
          Details
        </button>
        <button
          onClick={() => onDeploy(agent)}
          style={{
            background: `${agent.color}20`,
            border: `1px solid ${agent.color}40`,
            color: agent.color,
            fontSize: 11,
            fontWeight: 600,
            padding: '4px 12px',
            borderRadius: 6,
            cursor: 'pointer',
            transition: 'all 0.15s',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = `${agent.color}35`
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = `${agent.color}20`
          }}
        >
          Deploy
        </button>
      </div>
    </motion.div>
  )
}
