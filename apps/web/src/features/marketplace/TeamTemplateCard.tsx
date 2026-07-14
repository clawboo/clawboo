import { motion } from 'framer-motion'
import { useMemo } from 'react'
import type { TeamTemplate, ProfileLike } from '@/features/teams/types'
import { Button } from '@/features/shared/Button'
import { SOURCE_META, TEMPLATE_CATEGORIES, resolveTeamAgents } from './teamCatalog'

// ─── Helpers ────────────────────────────────────────────────────────────────────

function isTeamTemplate(p: ProfileLike): p is TeamTemplate {
  return 'source' in p && 'category' in p
}

function getCategoryLabel(category: string): string {
  const entry = TEMPLATE_CATEGORIES.find((c) => c.key === category)
  return entry?.label ?? category
}

// ─── TeamTemplateCard ───────────────────────────────────────────────────────────

interface TeamTemplateCardProps {
  profile: ProfileLike
  onDeploy: (profile: ProfileLike) => void
  onDetails: (template: TeamTemplate) => void
}

export function TeamTemplateCard({ profile, onDeploy, onDetails }: TeamTemplateCardProps) {
  const isTpl = isTeamTemplate(profile)
  const sourceMeta = isTpl ? SOURCE_META[profile.source] : null
  const resolved = useMemo(() => resolveTeamAgents(profile), [profile])
  const isSynthetic = isTpl && profile.isSynthetic === true

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="group flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-border-strong"
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      {/* Top row: emoji tile + name + agent count */}
      <div className="flex items-center gap-2.5">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[17px]"
          style={{ background: `${profile.color}20` }}
        >
          {profile.emoji}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[14px] font-semibold text-foreground"
            style={{ letterSpacing: '-0.01em' }}
          >
            {profile.name}
          </div>
          <div className="font-data text-[11px] text-foreground/45">
            {resolved.length} agent{resolved.length !== 1 ? 's' : ''}
          </div>
        </div>
      </div>

      {/* Source badge + category + synthetic pill */}
      {isTpl && sourceMeta && (
        <div className="flex flex-wrap items-center gap-1.5">
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
          {isSynthetic && (
            <span
              className="whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase text-amber"
              style={{
                background: 'rgb(var(--amber-rgb) / 0.12)',
                borderColor: 'rgb(var(--amber-rgb) / 0.35)',
                letterSpacing: '0.03em',
              }}
            >
              Synthetic
            </span>
          )}
          <span className="text-[10px] text-foreground/35">
            {getCategoryLabel(profile.category)}
          </span>
        </div>
      )}

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
        {profile.description}
      </div>

      {/* Agent roles */}
      <div className="truncate text-[11px] text-foreground/40">
        {resolved.map((a) => a.role || a.name).join(', ')}
      </div>

      {/* Bottom row: tags + buttons */}
      <div className="mt-0.5 flex items-center gap-2">
        {/* Tag pills (first 3) */}
        {isTpl && (
          <div className="flex min-w-0 flex-1 gap-1.5 overflow-hidden">
            {profile.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="whitespace-nowrap rounded-full border border-border bg-foreground/[0.03] px-2 py-0.5 text-[9px] text-foreground/40"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
        {!isTpl && <div className="flex-1" />}

        {/* Details button */}
        {isTpl && (
          <Button variant="outline" size="sm" onClick={() => onDetails(profile)}>
            Details
          </Button>
        )}

        {/* Deploy button */}
        <Button
          variant="primary"
          size="sm"
          data-testid="team-card-deploy"
          onClick={() => onDeploy(profile)}
        >
          Deploy
        </Button>
      </div>
    </motion.div>
  )
}
