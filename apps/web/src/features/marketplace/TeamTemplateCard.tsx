import { motion } from 'framer-motion'
import type { TeamTemplate, ProfileLike } from '@/features/teams/types'
import { SOURCE_META, TEMPLATE_CATEGORIES } from './teamCatalog'

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

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      style={{
        background: '#111827',
        border: `1px solid ${profile.color}25`,
        borderRadius: 10,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = `${profile.color}45`
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = `${profile.color}25`
      }}
    >
      {/* Top row: emoji + name + agent count */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `${profile.color}20`,
            fontSize: 16,
            flexShrink: 0,
          }}
        >
          {profile.emoji}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#E8E8E8' }}>{profile.name}</div>
          <div style={{ fontSize: 10, color: 'rgba(232,232,232,0.45)' }}>
            {profile.agents.length} agent{profile.agents.length !== 1 ? 's' : ''}
          </div>
        </div>
      </div>

      {/* Source badge + category */}
      {isTpl && sourceMeta && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
          <span style={{ fontSize: 10, color: 'rgba(232,232,232,0.35)' }}>
            {getCategoryLabel(profile.category)}
          </span>
        </div>
      )}

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
        {profile.description}
      </div>

      {/* Agent roles */}
      <div
        style={{
          fontSize: 11,
          color: 'rgba(232,232,232,0.35)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {profile.agents.map((a) => ('role' in a ? a.role : a.name)).join(', ')}
      </div>

      {/* Bottom row: tags + buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* Tag pills (first 3) */}
        {isTpl && (
          <div style={{ display: 'flex', gap: 4, flex: 1, minWidth: 0, overflow: 'hidden' }}>
            {profile.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                style={{
                  fontSize: 9,
                  padding: '1px 6px',
                  borderRadius: 10,
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  color: 'rgba(232,232,232,0.35)',
                  whiteSpace: 'nowrap',
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        )}
        {!isTpl && <div style={{ flex: 1 }} />}

        {/* Details button */}
        {isTpl && (
          <button
            onClick={() => onDetails(profile)}
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
        )}

        {/* Deploy button */}
        <button
          onClick={() => onDeploy(profile)}
          style={{
            background: `${profile.color}20`,
            border: `1px solid ${profile.color}40`,
            color: profile.color,
            fontSize: 11,
            fontWeight: 600,
            padding: '4px 12px',
            borderRadius: 6,
            cursor: 'pointer',
            transition: 'all 0.15s',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = `${profile.color}35`
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = `${profile.color}20`
          }}
        >
          Deploy
        </button>
      </div>
    </motion.div>
  )
}
