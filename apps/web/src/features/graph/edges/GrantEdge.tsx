import { memo } from 'react'
import type { EdgeProps } from '@xyflow/react'
import { OrbitalEdge } from './OrbitalEdge'
import { isGrantEdgeData, type GrantEdgeMode, type GrantEdgeState } from '../types'

// ─── GrantEdge — the authorization edge: agent → capability ──────────────────
//
// Two orthogonal channels, so both can be read at once:
//
//   GEOMETRY = PRIVILEGE. Static, and static on purpose — it must survive
//   zoom-out, screenshots, and reduced motion, none of which an animation does.
//     1px dotted  read    · 2px solid  write   · 3px  admin
//
//   ANIMATION = STATE. Transient, and only for states a human can act on:
//     marching amber dashes  a decision is pending
//     flat grey              suspended (including the global freeze)
//     faded                  revoked — revocation must be SEEN, not just applied
//
// A thin wrapper over `OrbitalEdge` rather than a new edge component: the
// gradient stroke, the peacock draw-in, the hover cascade and the MiniGraph
// visibility contract are all behaviours a grant edge wants unchanged, and
// forking them would guarantee the two drift.

const MODE_GEOMETRY: Record<GrantEdgeMode, { dash?: string; width: number }> = {
  // Dotted reads as "may look, not touch" without needing a legend.
  read: { dash: '1 5', width: 1 },
  write: { width: 2 },
  // Thickest, because an admin grant is the one worth spotting from across the
  // canvas when you are scanning for what to revoke.
  admin: { width: 3 },
}

const STATE_ACCENT: Record<GrantEdgeState, string> = {
  proposed: 'var(--muted-foreground)',
  active: 'var(--violet)',
  suspended: 'var(--muted-foreground)',
  revoked: 'var(--muted-foreground)',
  expired: 'var(--muted-foreground)',
}

export const GrantEdge = memo(function GrantEdge(props: EdgeProps) {
  const data = props.data
  // A malformed edge still renders as an ordinary connector line rather than
  // vanishing: a missing grant edge would read as "no permission", which is a
  // materially different and more alarming claim than "we could not type this".
  if (!isGrantEdgeData(data)) return <OrbitalEdge edge={props} accent="var(--violet)" />

  const geometry = MODE_GEOMETRY[data.mode] ?? MODE_GEOMETRY.write
  const pending = (data.pendingApprovals ?? 0) > 0

  // Pending outranks the mode accent: an edge waiting on a human is the thing
  // you should look at first, whatever privilege it carries.
  const accent = pending ? 'var(--amber)' : (STATE_ACCENT[data.state] ?? 'var(--violet)')

  return (
    <OrbitalEdge
      edge={props}
      accent={accent}
      dash={pending ? '4 4' : geometry.dash}
      width={geometry.width}
      march={pending}
    />
  )
})
