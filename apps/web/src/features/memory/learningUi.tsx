// Shared learning-overlay UI atoms — one mapping for the list panel (MemoryPanel)
// and the graph inspector so a status never renders two different ways.
//
// Pill semantics (accent conventions): preferred → mint; tentative → neutral;
// contested → amber "verify" nudge; dead_end → muted. Cited-only entries render
// a subtle usage count instead of a pill — usage is data, not endorsement.

import { CircleSlash, MessageSquareWarning, Quote, ThumbsDown, ThumbsUp } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { StatusPill } from '@/features/shared/StatusPill'
import { formatRelative } from '@/lib/formatRelative'
import type { LearningEntry, LearningTrailItem, OutcomeKind } from '@/lib/memoryClient'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

export function LearningPill({ learning }: { learning: LearningEntry | null | undefined }) {
  if (!learning) return null
  switch (learning.status) {
    case 'preferred':
      return <StatusPill tone="done" label="preferred" />
    case 'tentative':
      return <StatusPill tone="idle" label="tentative" />
    case 'contested':
      return <StatusPill tone="warning" label="contested · verify" />
    case 'dead_end':
      return <StatusPill tone="idle" label="dead end" style={{ opacity: 0.65 }} />
    default:
      // Cited-only: honest usage frequency without endorsement semantics.
      if (learning.uses > 0) {
        return (
          <span className="font-data" style={{ fontSize: 10, color: muted(0.45), flexShrink: 0 }}>
            used {learning.uses}×
          </span>
        )
      }
      return null
  }
}

/** `by {agent} · {runtime} · task {id8}` — null segments omitted; rows saved
 *  before provenance existed (all-null) render nothing. */
export function provenanceCaption(
  row: {
    createdByAgentId: string | null
    createdByRuntime: string | null
    sourceTaskId: string | null
  },
  agentName?: string | null,
): string | null {
  if (!row.createdByAgentId && !row.createdByRuntime && !row.sourceTaskId) return null
  const parts = [`by ${agentName ?? row.createdByAgentId ?? 'user'}`]
  if (row.createdByRuntime) parts.push(row.createdByRuntime)
  if (row.sourceTaskId) parts.push(`task ${row.sourceTaskId.slice(0, 8)}`)
  return parts.join(' · ')
}

const OUTCOME_GLYPH: Record<OutcomeKind, { Icon: LucideIcon; color: string }> = {
  useful: { Icon: ThumbsUp, color: 'var(--mint)' },
  dead_end: { Icon: ThumbsDown, color: 'var(--amber)' },
  corrected: { Icon: MessageSquareWarning, color: 'var(--amber)' },
  cited: { Icon: Quote, color: 'rgb(var(--foreground-rgb) / 0.45)' },
}

export function OutcomeTrail({
  items,
  emptyLabel = 'No feedback yet',
}: {
  items: LearningTrailItem[]
  emptyLabel?: string
}) {
  if (items.length === 0) {
    return (
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: muted(0.4) }}
      >
        <CircleSlash size={11} /> {emptyLabel}
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {items.map((item, i) => {
        const { Icon, color } = OUTCOME_GLYPH[item.kind]
        const reporter = item.agentId ?? item.runtime ?? 'user'
        return (
          <div
            key={`${item.createdAt}-${i}`}
            data-testid="memory-outcome-trail-item"
            style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 11 }}
          >
            <Icon size={11} strokeWidth={2.25} style={{ color, marginTop: 2, flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <span style={{ color: muted(0.7) }}>{item.kind.replace('_', ' ')}</span>
              <span
                className="font-data"
                style={{ color: muted(0.4), marginLeft: 6, fontSize: 10 }}
              >
                {reporter} · {formatRelative(item.createdAt)}
              </span>
              {item.note && (
                <div style={{ color: muted(0.55), lineHeight: 1.45, marginTop: 1 }}>
                  {item.note}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
