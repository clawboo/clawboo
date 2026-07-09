import { useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ExternalLink, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BooAvatar } from '@clawboo/ui'
import type { AgentCatalogEntry, TeamTemplate } from '@/features/teams/types'
import { Button, IconButton } from '@/features/shared/Button'
import { Chip } from '@/features/shared/Chip'
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

const SECTION_LABEL = 'font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45'

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
        className="fixed inset-0 z-[60] flex items-center justify-center p-6"
        style={{ background: 'var(--overlay-scrim)' }}
      >
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.2 }}
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-[640px] overflow-y-auto rounded-2xl border border-border bg-surface p-6"
          style={{ maxHeight: '85vh', boxShadow: 'var(--shadow-overlay)' }}
        >
          {/* Close button */}
          <div className="absolute right-3 top-3 z-[2]">
            <IconButton variant="ghost" size="sm" label="Close" onClick={onClose}>
              <X size={16} strokeWidth={2} />
            </IconButton>
          </div>

          {/* Header */}
          <div className="mb-4 flex items-center gap-3.5">
            <div className="shrink-0">
              <BooAvatar seed={agent.name} size={48} />
            </div>
            <div className="min-w-0 flex-1 pr-7">
              <div
                className="font-display text-[18px] font-bold text-foreground"
                style={{ letterSpacing: '-0.01em' }}
              >
                {agent.name}
              </div>
              <div className="mt-0.5 text-[12.5px] text-foreground/55">{agent.role}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {sourceMeta && (
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
                )}
                <span
                  className="rounded-md border px-1.5 py-0.5 text-[9px] font-medium uppercase"
                  style={{
                    color: `${agent.color}cc`,
                    background: `${agent.color}14`,
                    borderColor: `${agent.color}30`,
                    letterSpacing: '0.03em',
                  }}
                >
                  {formatDomain(agent.domain)}
                </span>
                <span className="text-[11px] text-foreground/35">
                  {getCategoryLabel(agent.category)}
                </span>
              </div>
            </div>
          </div>

          {/* Description */}
          <div className="mb-4 text-[13px] leading-relaxed text-foreground/65">
            {agent.description}
          </div>

          {/* Source attribution */}
          {agent.sourceUrl && (
            <div className="mb-4">
              <a
                href={agent.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-mint/80 no-underline transition-colors hover:text-mint"
              >
                Source: {sourceMeta?.label ?? agent.source}
                <ExternalLink size={11} className="ml-0.5 inline" strokeWidth={2} />
              </a>
            </div>
          )}

          {/* Skills section */}
          {resolvedSkills.length > 0 && (
            <div className="mb-4">
              <div className={`mb-2 ${SECTION_LABEL}`}>Skills ({resolvedSkills.length})</div>
              <div className="flex flex-wrap gap-1.5">
                {resolvedSkills.map(({ id, catalog }) => {
                  const label = catalog?.name ?? id
                  const clickable = !!onSkillClick
                  return (
                    <Chip
                      key={id}
                      size="sm"
                      accent="var(--mint)"
                      active
                      onClick={clickable ? () => onSkillClick(id) : undefined}
                    >
                      {label}
                    </Chip>
                  )
                })}
              </div>
            </div>
          )}

          {/* Teams section */}
          {teams.length > 0 && (
            <div className="mb-4">
              <div className={`mb-2 ${SECTION_LABEL}`}>
                Appears in {teams.length} team{teams.length === 1 ? '' : 's'}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {teams.map((team) => {
                  const clickable = !!onTeamClick
                  return (
                    <Chip
                      key={team.id}
                      size="sm"
                      accent={team.color}
                      active
                      onClick={clickable ? () => onTeamClick(team) : undefined}
                    >
                      <span className="text-[11px]">{team.emoji}</span>
                      {team.name}
                    </Chip>
                  )
                })}
              </div>
            </div>
          )}

          {/* Full identity markdown */}
          <div className="mb-4">
            <div className={`mb-1 ${SECTION_LABEL}`}>Identity</div>
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.04em] text-foreground/35">
              Full source from {sourceMeta?.label ?? agent.source} — preserved verbatim
            </div>
            <div
              className="markdown-body overflow-y-auto rounded-xl border border-border bg-foreground/[0.02] px-4 py-3 text-[12px] leading-relaxed text-foreground/75"
              style={{ maxHeight: '50vh' }}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {agent.identityTemplate}
              </ReactMarkdown>
            </div>
          </div>

          {/* Tags */}
          {agent.tags.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-1.5">
              {agent.tags.map((tag) => (
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
            <Button variant="primary" size="sm" onClick={() => onDeploy(agent)}>
              Deploy
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
