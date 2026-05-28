/**
 * TemplateGrid — Phase 16 scale companion to TemplateFanDeck.
 *
 * Compact 3-column grid for browsing 82+ templates. Each card is a
 * brand-tinted mini-card that picks-on-click. The fan stays the "signature
 * moment" for small filtered sets; the grid handles the scan-and-pick case.
 *
 * The CreateTeamModal chooses Fan vs Grid automatically based on filtered
 * count (≤ 12 → Fan, > 12 → Grid). The user can override via the toggle.
 */
import { motion } from 'framer-motion'
import { Info } from 'lucide-react'
import type { TeamTemplate } from './types'
import { SOURCE_META, resolveTeamAgents } from '@/features/marketplace/teamCatalog'

const STAGE_HEIGHT = 360

export interface TemplateGridProps {
  templates: TeamTemplate[]
  onPick: (template: TeamTemplate) => void
  onShowDetails: (template: TeamTemplate) => void
}

export function TemplateGrid({ templates, onPick, onShowDetails }: TemplateGridProps) {
  if (templates.length === 0) {
    return (
      <div
        className="mt-2 flex items-center justify-center text-[12px] text-secondary/40"
        style={{ height: STAGE_HEIGHT }}
      >
        No templates match your search.
      </div>
    )
  }

  return (
    <div
      className="mt-2 grid grid-cols-3 gap-2.5 overflow-y-auto pr-1"
      style={{ maxHeight: STAGE_HEIGHT }}
    >
      {templates.map((template, index) => (
        <GridCard
          key={template.id}
          template={template}
          index={index}
          onPick={onPick}
          onShowDetails={onShowDetails}
        />
      ))}
    </div>
  )
}

interface GridCardProps {
  template: TeamTemplate
  index: number
  onPick: (template: TeamTemplate) => void
  onShowDetails: (template: TeamTemplate) => void
}

function GridCard({ template, index, onPick, onShowDetails }: GridCardProps) {
  const srcMeta = SOURCE_META[template.source]
  const agentCount = resolveTeamAgents(template).length

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        delay: Math.min(index * 0.015, 0.4),
        type: 'spring',
        stiffness: 280,
        damping: 28,
      }}
      whileHover={{ y: -1 }}
      onClick={() => onPick(template)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPick(template)
        }
      }}
      aria-label={`Pick ${template.name}`}
      className="relative flex cursor-pointer flex-col gap-1.5 overflow-hidden rounded-xl p-2.5 pt-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
      style={{
        // SOLID card — matches FanCard. Brand color is an edge accent (border +
        // 2px top band), never a body wash.
        background: 'var(--surface-raised)',
        border: `1px solid ${template.color}30`,
        boxShadow: 'var(--shadow-raised)',
      }}
    >
      {/* Top accent band — same brand cue as FanCard. */}
      <div
        aria-hidden
        className="absolute left-0 right-0 top-0"
        style={{ height: 2, background: template.color, opacity: 0.55 }}
      />
      {/* Top row: emoji crest + source pill */}
      <div className="flex items-center justify-between">
        <div
          className="flex items-center justify-center rounded-md"
          style={{
            width: 28,
            height: 28,
            background: `${template.color}22`,
            border: `1px solid ${template.color}38`,
            fontSize: 16,
          }}
        >
          {template.emoji}
        </div>
        <span
          style={{
            background: `${srcMeta.color}1d`,
            border: `1px solid ${srcMeta.color}38`,
            color: srcMeta.color,
            borderRadius: 4,
            padding: '0px 4px',
            fontSize: 8,
            fontWeight: 600,
            letterSpacing: '0.04em',
            whiteSpace: 'nowrap',
            textTransform: 'uppercase',
          }}
        >
          {srcMeta.label}
        </span>
      </div>

      {/* Name */}
      <div
        className="text-text"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '-0.005em',
          lineHeight: 1.25,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          minHeight: 28,
        }}
      >
        {template.name}
      </div>

      {/* Bottom row: agent count + details affordance */}
      <div className="mt-auto flex items-center justify-between pt-1">
        <span
          className="text-secondary/55"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            letterSpacing: '0.06em',
            fontVariantNumeric: 'tabular-nums',
            textTransform: 'uppercase',
          }}
        >
          {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onShowDetails(template)
          }}
          aria-label={`Show details for ${template.name}`}
          className="rounded p-0.5 text-secondary/30 transition-colors hover:text-secondary/70"
        >
          <Info style={{ width: 12, height: 12 }} strokeWidth={2.2} />
        </button>
      </div>
    </motion.div>
  )
}
