import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { BooAvatar } from '@clawboo/ui'
import type { TeamTemplate } from '@/features/teams/types'
import { SOURCE_META, TEMPLATE_CATEGORIES, resolveTeamAgents } from './teamCatalog'

// ─── Parsing helpers ────────────────────────────────────────────────────────────

function parseSkillsFromToolsMd(toolsMd: string): string[] {
  return toolsMd
    .split('\n')
    .filter((line) => /^\s*-\s+/.test(line))
    .map((line) => line.replace(/^\s*-\s+/, '').trim())
    .filter(Boolean)
}

function parseMentionsFromAgentsMd(agentsMd: string): string[] {
  const mentions: string[] = []
  const regex = /@([\w][\w ._-]{0,60})/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(agentsMd)) !== null) {
    mentions.push(match[1])
  }
  return [...new Set(mentions)]
}

function getCategoryLabel(category: string): string {
  const entry = TEMPLATE_CATEGORIES.find((c) => c.key === category)
  return entry?.label ?? category
}

// ─── TeamTemplateDetail ─────────────────────────────────────────────────────────

interface TeamTemplateDetailProps {
  template: TeamTemplate
  onClose: () => void
  onDeploy: (template: TeamTemplate) => void
}

export function TeamTemplateDetail({ template, onClose, onDeploy }: TeamTemplateDetailProps) {
  const sourceMeta = SOURCE_META[template.source]
  const resolved = useMemo(() => resolveTeamAgents(template), [template])
  const [narrativeExpanded, setNarrativeExpanded] = useState(false)
  const workflowNarrative = template.workflowNarrative ?? ''
  const narrativePreview = workflowNarrative.slice(0, 300)
  const hasMoreNarrative = workflowNarrative.length > 300

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <AnimatePresence>
      {/* Overlay */}
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
        }}
      >
        {/* Modal */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.2 }}
          onClick={(e) => e.stopPropagation()}
          style={{
            width: '100%',
            maxWidth: 520,
            maxHeight: '80vh',
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
            }}
          >
            <X size={16} />
          </button>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: `${template.color}20`,
                fontSize: 24,
                flexShrink: 0,
              }}
            >
              {template.emoji}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#E8E8E8' }}>{template.name}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
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
                <span style={{ fontSize: 11, color: 'rgba(232,232,232,0.35)' }}>
                  {getCategoryLabel(template.category)}
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
              marginBottom: 16,
            }}
          >
            {template.description}
          </div>

          {/* Source attribution */}
          {template.sourceUrl && (
            <div style={{ marginBottom: 16 }}>
              <a
                href={template.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: 11,
                  color: 'rgba(52,211,153,0.7)',
                  textDecoration: 'none',
                }}
              >
                Source: {sourceMeta.label} ↗
              </a>
            </div>
          )}

          {/* Workflow narrative */}
          {workflowNarrative && (
            <div style={{ marginBottom: 16 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'rgba(232,232,232,0.55)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: 8,
                }}
              >
                Workflow
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'rgba(232,232,232,0.6)',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.04)',
                  borderRadius: 8,
                  padding: '10px 12px',
                }}
              >
                {narrativeExpanded || !hasMoreNarrative
                  ? workflowNarrative
                  : `${narrativePreview}…`}
                {hasMoreNarrative && (
                  <button
                    onClick={() => setNarrativeExpanded((v) => !v)}
                    style={{
                      display: 'block',
                      marginTop: 6,
                      background: 'transparent',
                      border: 'none',
                      color: 'rgba(52,211,153,0.75)',
                      fontSize: 11,
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    {narrativeExpanded ? 'Show less' : 'Show more'}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Agents section */}
          <div style={{ marginBottom: 16 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'rgba(232,232,232,0.55)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginBottom: 10,
              }}
            >
              Agents ({resolved.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {resolved.map((agent) => {
                const skills = parseSkillsFromToolsMd(agent.toolsTemplate)
                const mentions = agent.agentsTemplate
                  ? parseMentionsFromAgentsMd(agent.agentsTemplate)
                  : []

                return (
                  <div
                    key={agent.id}
                    style={{
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(255,255,255,0.04)',
                      borderRadius: 8,
                      padding: '10px 12px',
                    }}
                  >
                    {/* Agent header */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <BooAvatar seed={agent.name} size={32} />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#E8E8E8' }}>
                          {agent.name}
                        </div>
                        <div style={{ fontSize: 11, color: 'rgba(232,232,232,0.45)' }}>
                          {agent.role}
                        </div>
                      </div>
                    </div>

                    {/* Skills */}
                    {skills.length > 0 && (
                      <div style={{ marginTop: 6 }}>
                        <div
                          style={{
                            fontSize: 10,
                            color: 'rgba(232,232,232,0.35)',
                            marginBottom: 4,
                          }}
                        >
                          Skills
                        </div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {skills.map((skill) => (
                            <span
                              key={skill}
                              style={{
                                fontSize: 9,
                                padding: '1px 6px',
                                borderRadius: 10,
                                background: 'rgba(52,211,153,0.08)',
                                border: '1px solid rgba(52,211,153,0.15)',
                                color: 'rgba(52,211,153,0.65)',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {skill}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Routing */}
                    {mentions.length > 0 && (
                      <div style={{ marginTop: 6 }}>
                        <div style={{ fontSize: 10, color: 'rgba(232,232,232,0.35)' }}>
                          Routes to:{' '}
                          {mentions.map((m, i) => (
                            <span key={m}>
                              <span style={{ color: 'rgba(233,69,96,0.65)' }}>@{m}</span>
                              {i < mentions.length - 1 ? ', ' : ''}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Tags */}
          {template.tags.length > 0 && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 16 }}>
              {template.tags.map((tag) => (
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
              paddingTop: 16,
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
              onClick={() => onDeploy(template)}
              style={{
                background: `${template.color}20`,
                border: `1px solid ${template.color}40`,
                color: template.color,
                fontSize: 12,
                fontWeight: 600,
                padding: '6px 16px',
                borderRadius: 6,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = `${template.color}35`
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = `${template.color}20`
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
