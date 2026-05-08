import { useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BooAvatar } from '@clawboo/ui'
import type { AgentCatalogEntry, TeamTemplate } from '@/features/teams/types'
import { SOURCE_META, TEMPLATE_CATEGORIES, teamsContainingAgent } from './teamCatalog'
import { getCatalogSkill } from './catalog'
import { MD_COMPONENTS } from '@/features/chat/chatComponents'

// ─── Helpers ────────────────────────────────────────────────────────────────────

function getCategoryLabel(category: string): string {
  const entry = TEMPLATE_CATEGORIES.find((c) => c.key === category)
  return entry?.label ?? category
}

function formatDomain(domain: string): string {
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

// ─── AgentTemplateDetail ────────────────────────────────────────────────────────

interface AgentTemplateDetailProps {
  agent: AgentCatalogEntry
  onClose: () => void
  onDeploy: (agent: AgentCatalogEntry) => void
  onSkillClick?: (skillId: string) => void
  onTeamClick?: (team: TeamTemplate) => void
}

export function AgentTemplateDetail({
  agent,
  onClose,
  onDeploy,
  onSkillClick,
  onTeamClick,
}: AgentTemplateDetailProps) {
  const sourceMeta = SOURCE_META[agent.source]
  const teams = useMemo(() => teamsContainingAgent(agent.id), [agent.id])
  const resolvedSkills = useMemo(
    () =>
      agent.skillIds.map((id) => ({
        id,
        catalog: getCatalogSkill(id),
      })),
    [agent.skillIds],
  )

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.6)',
          zIndex: 60,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.2 }}
          onClick={(e) => e.stopPropagation()}
          style={{
            width: '100%',
            maxWidth: 640,
            maxHeight: '85vh',
            overflowY: 'auto',
            background: '#111827',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 12,
            padding: 24,
            position: 'relative',
          }}
        >
          {/* Close button */}
          <button
            onClick={onClose}
            style={{
              position: 'absolute',
              top: 16,
              right: 16,
              background: 'transparent',
              border: 'none',
              color: 'rgba(232,232,232,0.45)',
              cursor: 'pointer',
              padding: 4,
              zIndex: 2,
            }}
          >
            <X size={16} />
          </button>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
            <div style={{ flexShrink: 0 }}>
              <BooAvatar seed={agent.name} size={48} />
            </div>
            <div style={{ flex: 1, minWidth: 0, paddingRight: 28 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#E8E8E8' }}>{agent.name}</div>
              <div style={{ fontSize: 12, color: 'rgba(232,232,232,0.55)', marginTop: 2 }}>
                {agent.role}
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginTop: 6,
                  flexWrap: 'wrap',
                }}
              >
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
                    letterSpacing: '0.03em',
                  }}
                >
                  {formatDomain(agent.domain)}
                </span>
                <span style={{ fontSize: 11, color: 'rgba(232,232,232,0.35)' }}>
                  {getCategoryLabel(agent.category)}
                </span>
              </div>
            </div>
          </div>

          {/* Description */}
          <div
            style={{
              fontSize: 13,
              color: 'rgba(232,232,232,0.65)',
              lineHeight: 1.6,
              marginBottom: 14,
            }}
          >
            {agent.description}
          </div>

          {/* Source attribution */}
          {agent.sourceUrl && (
            <div style={{ marginBottom: 14 }}>
              <a
                href={agent.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: 11,
                  color: 'rgba(52,211,153,0.7)',
                  textDecoration: 'none',
                }}
              >
                Source: {sourceMeta?.label ?? agent.source} ↗
              </a>
            </div>
          )}

          {/* Skills section */}
          {resolvedSkills.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'rgba(232,232,232,0.55)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: 6,
                }}
              >
                Skills ({resolvedSkills.length})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {resolvedSkills.map(({ id, catalog }) => {
                  const label = catalog?.name ?? id
                  const clickable = !!onSkillClick
                  return (
                    <button
                      key={id}
                      onClick={clickable ? () => onSkillClick(id) : undefined}
                      disabled={!clickable}
                      style={{
                        fontSize: 10,
                        padding: '3px 8px',
                        borderRadius: 10,
                        background: 'rgba(52,211,153,0.1)',
                        border: '1px solid rgba(52,211,153,0.22)',
                        color: 'rgba(52,211,153,0.85)',
                        whiteSpace: 'nowrap',
                        cursor: clickable ? 'pointer' : 'default',
                        transition: 'all 0.15s',
                      }}
                      onMouseEnter={(e) => {
                        if (clickable) {
                          e.currentTarget.style.background = 'rgba(52,211,153,0.2)'
                          e.currentTarget.style.borderColor = 'rgba(52,211,153,0.4)'
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (clickable) {
                          e.currentTarget.style.background = 'rgba(52,211,153,0.1)'
                          e.currentTarget.style.borderColor = 'rgba(52,211,153,0.22)'
                        }
                      }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Teams section */}
          {teams.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'rgba(232,232,232,0.55)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: 6,
                }}
              >
                Appears in {teams.length} team{teams.length === 1 ? '' : 's'}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {teams.map((team) => {
                  const clickable = !!onTeamClick
                  return (
                    <button
                      key={team.id}
                      onClick={clickable ? () => onTeamClick(team) : undefined}
                      disabled={!clickable}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        fontSize: 10,
                        padding: '3px 8px',
                        borderRadius: 10,
                        background: `${team.color}18`,
                        border: `1px solid ${team.color}35`,
                        color: `${team.color}dd`,
                        whiteSpace: 'nowrap',
                        cursor: clickable ? 'pointer' : 'default',
                        transition: 'all 0.15s',
                      }}
                      onMouseEnter={(e) => {
                        if (clickable) {
                          e.currentTarget.style.background = `${team.color}30`
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (clickable) {
                          e.currentTarget.style.background = `${team.color}18`
                        }
                      }}
                    >
                      <span style={{ fontSize: 11 }}>{team.emoji}</span>
                      {team.name}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Full identity markdown */}
          <div style={{ marginBottom: 14 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'rgba(232,232,232,0.55)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginBottom: 4,
              }}
            >
              Identity
            </div>
            <div
              style={{
                fontSize: 10,
                color: 'rgba(232,232,232,0.35)',
                marginBottom: 8,
                fontStyle: 'italic',
              }}
            >
              Full source from {sourceMeta?.label ?? agent.source} — preserved verbatim
            </div>
            <div
              style={{
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.04)',
                borderRadius: 8,
                padding: '12px 16px',
                maxHeight: '50vh',
                overflowY: 'auto',
                fontSize: 12,
                color: 'rgba(232,232,232,0.75)',
                lineHeight: 1.6,
              }}
              className="markdown-body"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {agent.identityTemplate}
              </ReactMarkdown>
            </div>
          </div>

          {/* Tags */}
          {agent.tags.length > 0 && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 14 }}>
              {agent.tags.map((tag) => (
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

          {/* Footer */}
          <div
            style={{
              borderTop: '1px solid rgba(255,255,255,0.06)',
              paddingTop: 14,
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 8,
            }}
          >
            <button
              onClick={onClose}
              style={{
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'rgba(232,232,232,0.55)',
                fontSize: 12,
                fontWeight: 500,
                padding: '6px 16px',
                borderRadius: 6,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
              }}
            >
              Close
            </button>
            <button
              onClick={() => onDeploy(agent)}
              style={{
                background: `${agent.color}20`,
                border: `1px solid ${agent.color}40`,
                color: agent.color,
                fontSize: 12,
                fontWeight: 600,
                padding: '6px 16px',
                borderRadius: 6,
                cursor: 'pointer',
                transition: 'all 0.15s',
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
      </motion.div>
    </AnimatePresence>
  )
}
