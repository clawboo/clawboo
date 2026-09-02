import { useId, useMemo } from 'react'
import { ExternalLink, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BooAvatar } from '@clawboo/ui'
import type { TeamTemplate } from '@/features/teams/types'
import { Button, IconButton } from '@/features/shared/Button'
import { Modal } from '@/features/shared/Modal'
import { Chip } from '@/features/shared/Chip'
import { teamsContainingAgent } from './teamCatalog'
import { metaFor, sourceMetaFor } from './registry'
import { AGENT_FILE, type AgentIndexEntry, type CatalogIndex } from './catalogTypes'
import { useAgentBody } from './useCatalog'
import { getCatalogSkill } from './catalog'
import { MD_COMPONENTS } from '@/features/chat/chatComponents'
import { ProvenanceNote } from './ProvenanceNote'
import { provenanceFor } from './provenance'

// ─── Helpers ────────────────────────────────────────────────────────────────────

const SECTION_LABEL = 'font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground'

// ─── AgentTemplateDetail ────────────────────────────────────────────────────────

interface AgentTemplateDetailProps {
  catalog: CatalogIndex
  agent: AgentIndexEntry
  onClose: () => void
  onDeploy: (agent: AgentIndexEntry) => void
  onSkillClick?: (skillId: string) => void
  onTeamClick?: (team: TeamTemplate) => void
}

export function AgentTemplateDetail({
  catalog,
  agent,
  onClose,
  onDeploy,
  onSkillClick,
  onTeamClick,
}: AgentTemplateDetailProps) {
  const packMeta = sourceMetaFor(agent.packId)
  const categoryMeta = metaFor(agent.category)
  const teams = useMemo(() => teamsContainingAgent(catalog, agent.id), [catalog, agent.id])
  // The identity body and the attribution link are the only two fields this
  // sheet needs beyond the index row, and it is the only surface that needs
  // them, which is why they live in the body rather than in every index row.
  const { body } = useAgentBody(agent.id)
  const resolvedSkills = useMemo(
    () =>
      agent.skillIds.map((id) => ({
        id,
        catalog: getCatalogSkill(id),
      })),
    [agent.skillIds],
  )

  // Dialog semantics, focus trap, Escape and focus-return all come from Modal.
  const headingId = useId()

  return (
    <Modal
      open
      layer={60}
      labelledBy={headingId}
      onClose={onClose}
      scrimClassName="p-6"
      panelClassName="relative w-full max-w-[640px] overflow-y-auto rounded-2xl border border-border bg-surface p-6"
      panelStyle={{ maxHeight: '85vh', boxShadow: 'var(--shadow-overlay)' }}
      data-testid="agent-template-detail"
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
          {/* A heading element, not a div: `aria-labelledby` resolves a name from
              any element, but only a real heading joins the list screen-reader
              users navigate the sheet by. */}
          <h2
            id={headingId}
            className="font-display text-[18px] font-bold text-foreground"
            style={{ letterSpacing: '-0.01em', margin: 0 }}
          >
            {agent.name}
          </h2>
          <div className="mt-0.5 text-[12.5px] text-foreground/55">{agent.role}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
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
            <span
              className="rounded-md border px-1.5 py-0.5 text-[9px] font-medium uppercase"
              style={{
                color: `${categoryMeta.color}cc`,
                background: `${categoryMeta.color}14`,
                borderColor: `${categoryMeta.color}30`,
                letterSpacing: '0.03em',
              }}
            >
              {categoryMeta.label}
            </span>
          </div>
        </div>
      </div>

      <ProvenanceNote provenance={provenanceFor(catalog, agent.packId)} />

      {/* Description */}
      <div className="mb-4 text-[13px] leading-relaxed text-foreground/65">{agent.description}</div>

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
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.04em] text-muted-foreground">
          Full identity written to IDENTITY.md on deploy · {packMeta.label}
        </div>
        <div
          className="markdown-body overflow-y-auto rounded-xl border border-border bg-foreground/[0.02] px-4 py-3 text-[12px] leading-relaxed text-foreground/75"
          style={{ maxHeight: '50vh' }}
        >
          {body ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
              {body.files[AGENT_FILE.identity] ?? ''}
            </ReactMarkdown>
          ) : (
            <div className="text-[12px] text-muted-foreground">Loading the full source…</div>
          )}
        </div>
      </div>

      {/* Tags */}
      {agent.tags.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {agent.tags.map((tag) => (
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
        <Button variant="primary" size="sm" onClick={() => onDeploy(agent)}>
          Deploy
        </Button>
      </div>
    </Modal>
  )
}
