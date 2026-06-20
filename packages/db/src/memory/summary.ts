// ─── Structured-summary compaction template ─────────────────────────────────
// The fixed template that makes a compaction summary lossless on the load-bearing
// details (exact file paths, function names, error messages). Feeds the condensed
// context relay; a cheaper model can be delegated to fill it. This is a pure
// formatting helper — the memory store persists the rendered string as a fact.

export interface StructuredSummaryInput {
  goal: string
  constraints?: string[]
  progress?: {
    done?: string[]
    inProgress?: string[]
    blocked?: string[]
  }
  decisions?: string[]
  filesTouched?: string[]
  nextSteps?: string[]
  criticalContext?: string[]
}

function section(title: string, items: string[] | undefined): string | null {
  if (!items || items.length === 0) return null
  return `## ${title}\n${items.map((i) => `- ${i}`).join('\n')}`
}

/**
 * Render the fixed-template structured summary. Empty sections are omitted, but
 * the heading ORDER is always the same (Goal → Constraints → Progress →
 * Decisions → Files Touched → Next Steps → Critical Context) so the output is
 * predictable for a downstream reader (human or a cheaper summarizer model).
 *
 * NOTE: intentionally exported but not yet wired into a production caller — the
 * compaction → memory_save relay that consumes this template is a tracked
 * follow-up. The template + its contract are kept (and tested) so that wiring is
 * a drop-in; a reader should not assume a live consumer.
 */
export function buildStructuredSummary(input: StructuredSummaryInput): string {
  const parts: string[] = [`## Goal\n${input.goal.trim()}`]

  const constraints = section('Constraints', input.constraints)
  if (constraints) parts.push(constraints)

  const p = input.progress
  if (p && (p.done?.length || p.inProgress?.length || p.blocked?.length)) {
    const lines: string[] = ['## Progress']
    if (p.done?.length) lines.push('### Done', ...p.done.map((i) => `- ${i}`))
    if (p.inProgress?.length) lines.push('### In Progress', ...p.inProgress.map((i) => `- ${i}`))
    if (p.blocked?.length) lines.push('### Blocked', ...p.blocked.map((i) => `- ${i}`))
    parts.push(lines.join('\n'))
  }

  for (const [title, items] of [
    ['Key Decisions', input.decisions],
    ['Files Touched', input.filesTouched],
    ['Next Steps', input.nextSteps],
    ['Critical Context', input.criticalContext],
  ] as const) {
    const s = section(title, items)
    if (s) parts.push(s)
  }

  return parts.join('\n\n')
}
