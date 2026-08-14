import { memo } from 'react'
import type { EdgeProps } from '@xyflow/react'
import { OrbitalEdge } from './OrbitalEdge'

// ─── SkillEdge — gradient mint bezier: Boo → Skill ───────────────────────────
//
// Skill ownership is NOT directional — a Boo "has" a skill, and the
// relationship is symmetric. No marching-ants flow animation; instead the
// edge carries a calm direction-following gradient (quiet at the Boo, full
// accent at the tile) and draws in / retracts with the peacock expand.
// All rendering lives in the shared `OrbitalEdge`.

export const SkillEdge = memo(function SkillEdge(props: EdgeProps) {
  // The edge inherits its TILE's type accent (threaded via `data.accent` by
  // `buildGraphElements` — amber for Leadership, provider brand for the Model,
  // slate for the built-ins rollup) so an edge + its tile read as one unit.
  // No accent → mint, the skill/tool type accent.
  const accent = (props.data as { accent?: string } | undefined)?.accent ?? 'var(--mint)'
  return <OrbitalEdge edge={props} accent={accent} />
})
