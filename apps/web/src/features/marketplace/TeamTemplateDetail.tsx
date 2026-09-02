import { useEffect, useId, useMemo, useState } from 'react'
import { ExternalLink, X } from 'lucide-react'
import { BooAvatar } from '@clawboo/ui'
import type { TeamTemplate } from '@/features/teams/types'
import { Button, IconButton } from '@/features/shared/Button'
import { Modal } from '@/features/shared/Modal'
import { resolveTeamAgents, resolveTeamRoster } from './teamCatalog'
import { metaFor, sourceMetaFor } from './registry'
import { AGENT_FILE, type CatalogIndex, type TeamBody } from './catalogTypes'
import type { ResolvedAgent } from './teamCatalog'
import { loadTeamBody } from './catalogClient'
import { ProvenanceNote } from './ProvenanceNote'
import { provenanceFor } from './provenance'

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

const SECTION_LABEL = 'font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground'

// ─── TeamTemplateDetail ─────────────────────────────────────────────────────────

interface TeamTemplateDetailProps {
  catalog: CatalogIndex
  template: TeamTemplate
  onClose: () => void
  onDeploy: (template: TeamTemplate) => void
}

export function TeamTemplateDetail({
  catalog,
  template,
  onClose,
  onDeploy,
}: TeamTemplateDetailProps) {
  const packMeta = sourceMetaFor(template.packId)
  // The roster is synchronous, so the heading, the count, and every name/role
  // row paint on the first frame. Skills and @mentions come from the bodies and
  // fill in a tick later, which is the only part that needs the network.
  const roster = useMemo(() => resolveTeamRoster(catalog, template), [catalog, template])
  const [full, setFull] = useState<ResolvedAgent[] | null>(null)
  const [body, setBody] = useState<TeamBody | null>(null)

  useEffect(() => {
    let live = true
    setFull(null)
    setBody(null)
    void loadTeamBody(template.id).then(
      (b) => {
        if (!live) return
        setBody(b)
        void resolveTeamAgents(catalog, template, b.routing).then((agents) => {
          if (live) setFull(agents)
        })
      },
      () => {
        // A missing team body is not fatal: the roster still renders.
      },
    )
    return () => {
      live = false
    }
  }, [catalog, template])

  const bodyByAgent = useMemo(() => new Map((full ?? []).map((a) => [a.id, a] as const)), [full])

  const [narrativeExpanded, setNarrativeExpanded] = useState(false)
  const workflowNarrative = body?.workflowNarrative ?? ''
  const narrativePreview = workflowNarrative.slice(0, 300)
  const hasMoreNarrative = workflowNarrative.length > 300

  // Dialog semantics, focus trap, Escape and focus-return all come from Modal.
  const headingId = useId()

  return (
    <Modal
      open
      layer={60}
      labelledBy={headingId}
      onClose={onClose}
      scrimClassName="p-6"
      panelClassName="relative w-full max-w-[520px] overflow-y-auto rounded-2xl border border-border bg-surface p-6"
      panelStyle={{ maxHeight: '80vh', boxShadow: 'var(--shadow-overlay)' }}
      data-testid="team-template-detail"
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
          {/* A heading element, not a div — see AgentTemplateDetail. */}
          <h2
            id={headingId}
            className="font-display text-[18px] font-bold text-foreground"
            style={{ letterSpacing: '-0.01em', margin: 0 }}
          >
            {template.name}
          </h2>
          <div className="mt-1 flex items-center gap-1.5">
            <span
              className="rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase"
              style={{
                color: packMeta.color,
                background: `${packMeta.color}18`,
                borderColor: `${packMeta.color}35`,
                letterSpacing: '0.03em',
              }}
            >
              {packMeta.label}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {metaFor(template.category).label}
            </span>
          </div>
        </div>
      </div>

      <ProvenanceNote provenance={provenanceFor(catalog, template.packId)} />

      {/* Description */}
      <div className="mb-4 text-[13px] leading-relaxed text-foreground/65">
        {template.description}
      </div>

      {/* Source attribution */}
      {body?.sourceUrl && (
        <div className="mb-4">
          <a
            href={body.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-mint/80 no-underline transition-colors hover:text-mint"
          >
            Source: {packMeta.label}
            <ExternalLink size={11} className="ml-0.5 inline" strokeWidth={2} />
          </a>
        </div>
      )}

      {/* Workflow narrative */}
      {workflowNarrative && (
        <div className="mb-4">
          <div className={`mb-2 ${SECTION_LABEL}`}>Workflow</div>
          <div className="whitespace-pre-wrap rounded-xl border border-border bg-foreground/[0.02] px-3 py-2.5 text-[12px] leading-relaxed text-foreground/60">
            {narrativeExpanded || !hasMoreNarrative ? workflowNarrative : `${narrativePreview}…`}
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
        <div className={`mb-2.5 ${SECTION_LABEL}`}>Agents ({roster.length})</div>
        <div className="flex flex-col gap-2.5">
          {roster.map((agent) => {
            const detail = bodyByAgent.get(agent.id)
            const toolsMd = detail?.files[AGENT_FILE.tools]
            const agentsMd = detail?.files[AGENT_FILE.agents]
            const skills = toolsMd ? parseSkillsFromToolsMd(toolsMd) : []
            const mentions = agentsMd ? parseMentionsFromAgentsMd(agentsMd) : []

            return (
              <div
                key={agent.id}
                className="rounded-xl border border-border bg-foreground/[0.02] px-3 py-2.5"
              >
                {/* Agent header */}
                <div className="mb-1.5 flex items-center gap-2">
                  <BooAvatar seed={agent.name} size={32} />
                  <div>
                    <div className="text-[13px] font-semibold text-foreground">{agent.name}</div>
                    <div className="text-[11px] text-muted-foreground">{agent.role}</div>
                  </div>
                </div>

                {/* Skills */}
                {skills.length > 0 && (
                  <div className="mt-1.5">
                    <div className="mb-1 text-[10px] text-muted-foreground">Skills</div>
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
                    <div className="text-[10px] text-muted-foreground">
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
              className="whitespace-nowrap rounded-full border border-border bg-foreground/[0.03] px-2 py-0.5 text-[9px] text-muted-foreground"
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
    </Modal>
  )
}
