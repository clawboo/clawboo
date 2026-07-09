import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ExternalLink, X } from 'lucide-react'
import { BooAvatar } from '@clawboo/ui'
import type { TeamTemplate } from '@/features/teams/types'
import { Button, IconButton } from '@/features/shared/Button'
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

const SECTION_LABEL = 'font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45'

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
        className="fixed inset-0 z-[60] flex items-center justify-center p-6"
        style={{ background: 'var(--overlay-scrim)' }}
      >
        {/* Modal */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.2 }}
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-[520px] overflow-y-auto rounded-2xl border border-border bg-surface p-6"
          style={{ maxHeight: '80vh', boxShadow: 'var(--shadow-overlay)' }}
        >
          {/* Close button */}
          <div className="absolute right-3 top-3 z-[2]">
            <IconButton variant="ghost" size="sm" label="Close" onClick={onClose}>
              <X size={16} strokeWidth={2} />
            </IconButton>
          </div>

          {/* Header */}
          <div className="mb-4 flex items-center gap-3">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-[24px]"
              style={{ background: `${template.color}20` }}
            >
              {template.emoji}
            </div>
            <div className="min-w-0 flex-1">
              <div
                className="font-display text-[18px] font-bold text-foreground"
                style={{ letterSpacing: '-0.01em' }}
              >
                {template.name}
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <span
                  className="rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase"
                  style={{
                    color: sourceMeta.color,
                    background: `${sourceMeta.color}18`,
                    borderColor: `${sourceMeta.color}35`,
                    letterSpacing: '0.03em',
                  }}
                >
                  {sourceMeta.label}
                </span>
                <span className="text-[11px] text-foreground/35">
                  {getCategoryLabel(template.category)}
                </span>
              </div>
            </div>
          </div>

          {/* Description */}
          <div className="mb-4 text-[13px] leading-relaxed text-foreground/65">
            {template.description}
          </div>

          {/* Source attribution */}
          {template.sourceUrl && (
            <div className="mb-4">
              <a
                href={template.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-mint/80 no-underline transition-colors hover:text-mint"
              >
                Source: {sourceMeta.label}
                <ExternalLink size={11} className="ml-0.5 inline" strokeWidth={2} />
              </a>
            </div>
          )}

          {/* Workflow narrative */}
          {workflowNarrative && (
            <div className="mb-4">
              <div className={`mb-2 ${SECTION_LABEL}`}>Workflow</div>
              <div className="whitespace-pre-wrap rounded-xl border border-border bg-foreground/[0.02] px-3 py-2.5 text-[12px] leading-relaxed text-foreground/60">
                {narrativeExpanded || !hasMoreNarrative
                  ? workflowNarrative
                  : `${narrativePreview}…`}
                {hasMoreNarrative && (
                  <button
                    onClick={() => setNarrativeExpanded((v) => !v)}
                    className="mt-1.5 block cursor-pointer border-none bg-transparent p-0 text-[11px] text-mint/75 transition-colors hover:text-mint"
                  >
                    {narrativeExpanded ? 'Show less' : 'Show more'}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Agents section */}
          <div className="mb-4">
            <div className={`mb-2.5 ${SECTION_LABEL}`}>Agents ({resolved.length})</div>
            <div className="flex flex-col gap-2.5">
              {resolved.map((agent) => {
                const skills = parseSkillsFromToolsMd(agent.toolsTemplate)
                const mentions = agent.agentsTemplate
                  ? parseMentionsFromAgentsMd(agent.agentsTemplate)
                  : []

                return (
                  <div
                    key={agent.id}
                    className="rounded-xl border border-border bg-foreground/[0.02] px-3 py-2.5"
                  >
                    {/* Agent header */}
                    <div className="mb-1.5 flex items-center gap-2">
                      <BooAvatar seed={agent.name} size={32} />
                      <div>
                        <div className="text-[13px] font-semibold text-foreground">
                          {agent.name}
                        </div>
                        <div className="text-[11px] text-foreground/45">{agent.role}</div>
                      </div>
                    </div>

                    {/* Skills */}
                    {skills.length > 0 && (
                      <div className="mt-1.5">
                        <div className="mb-1 text-[10px] text-foreground/35">Skills</div>
                        <div className="flex flex-wrap gap-1.5">
                          {skills.map((skill) => (
                            <span
                              key={skill}
                              className="whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[9px]"
                              style={{
                                background: 'rgb(var(--mint-rgb) / 0.08)',
                                borderColor: 'rgb(var(--mint-rgb) / 0.15)',
                                color: 'rgb(var(--mint-rgb) / 0.65)',
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
                      <div className="mt-1.5">
                        <div className="text-[10px] text-foreground/35">
                          Routes to:{' '}
                          {mentions.map((m, i) => (
                            <span key={m}>
                              <span style={{ color: 'rgb(var(--primary-rgb) / 0.65)' }}>@{m}</span>
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
            <div className="mb-4 flex flex-wrap gap-1.5">
              {template.tags.map((tag) => (
                <span
                  key={tag}
                  className="whitespace-nowrap rounded-full border border-border bg-foreground/[0.03] px-2 py-0.5 text-[9px] text-foreground/35"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Footer */}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" size="sm" onClick={() => onDeploy(template)}>
              Deploy
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
