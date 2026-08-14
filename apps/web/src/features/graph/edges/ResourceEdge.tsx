import { memo } from 'react'
import type { EdgeProps } from '@xyflow/react'
import { OrbitalEdge } from './OrbitalEdge'

// ─── ResourceEdge — gradient VIOLET bezier: Boo → MCP connector ──────────────
//
// Violet is the connector TYPE accent (matches the ResourceNode tile), so the
// edge + tile read as one unit at a glance. Connector attachment is not a
// directional process — no flow animation, just the calm gradient stroke +
// peacock draw-in shared with SkillEdge via `OrbitalEdge`.

export const ResourceEdge = memo(function ResourceEdge(props: EdgeProps) {
  return <OrbitalEdge edge={props} accent="var(--violet)" />
})
