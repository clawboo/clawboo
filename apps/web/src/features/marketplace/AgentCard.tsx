import { motion } from 'framer-motion'
import { BooAvatar } from '@clawboo/ui'
import type { AgentIndexEntry, CatalogIndex } from './catalogTypes'
import { originOf, provenanceFor } from './provenance'
import { Button } from '@/features/shared/Button'
import { metaFor, sourceMetaFor } from './registry'

// ─── AgentCard ──────────────────────────────────────────────────────────────────

interface AgentCardProps {
  /** The emitted index, read only for this pack's provenance. */
  catalog: CatalogIndex | null
  agent: AgentIndexEntry
  index: number
  /** How many teams include this agent. Precomputed once per index load by
   *  `buildTeamCountByAgent`, because this card renders 304 times. */
  teamCount: number
  onDetails: (agent: AgentIndexEntry) => void
  onDeploy: (agent: AgentIndexEntry) => void
}

export function AgentCard({
  catalog,
  agent,
  index,
  onDetails,
  onDeploy,
  teamCount,
}: AgentCardProps) {
  const packMeta = sourceMetaFor(agent.packId)
  // Most of the catalog is adapted community work. Saying so on the card is the
  // difference between curating it and claiming authorship of it.
  const isCommunity = originOf(provenanceFor(catalog, agent.packId)) === 'community'
  const categoryMeta = metaFor(agent.category)
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

      {/* Badge row: pack + category. The domain badge is gone with the domain
          taxonomy; category was always the more useful of the two and is the one
          the filter row now works on. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className="whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase"
          style={{
            color: packMeta.color,
            background: `${packMeta.color}18`,
            borderColor: `${packMeta.color}35`,
            letterSpacing: '0.03em',
          }}
        >
          {packMeta.label}
        </span>
        <span
          className="whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[9px] font-medium uppercase"
          style={{
            color: `${categoryMeta.color}cc`,
            background: `${categoryMeta.color}14`,
            borderColor: `${categoryMeta.color}30`,
            letterSpacing: '0.03em',
          }}
        >
          {categoryMeta.label}
        </span>
        {isCommunity && (
          <span
            className="whitespace-nowrap rounded-md border border-border bg-foreground/[0.03] px-1.5 py-0.5 text-[9px] font-medium uppercase text-muted-foreground"
            style={{ letterSpacing: '0.03em' }}
            title="Adapted from a community project. The detail sheet names the author, the licence and the pinned commit."
          >
            Community
          </span>
        )}
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
      <div className="font-data flex gap-2.5 text-[11px] text-muted-foreground">
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
