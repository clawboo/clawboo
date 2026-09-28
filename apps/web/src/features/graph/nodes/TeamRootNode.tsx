import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { useGraphStore } from '../store'
import type { TeamRootNodeData } from '../types'
import { TeamBadge } from './TeamBadge'

// ─── TeamRootNode ─────────────────────────────────────────────────────────────
//
// The Atlas JUNCTION between Boo Zero and a team's cluster: the one point where
// every member's edge meets before a single edge runs up to Boo Zero. ELK lays
// it out at level 1 (between Boo Zero at level 0 and team members at level 2),
// so the edges form the two-level trunk shape the user drew in the sketch:
//
//   Boo Zero
//      │
//   ───┴───      ← top trunk (BZ → team-roots)
//   │     │
//  (A)   (B)     ← team-roots, each wearing its team's badge (this component)
//   │     │
//   ┌─┴─┐ ┌─┴─┐  ← per-team trunks (team-root → members)
//   m m m m m m  ← team members
//
// The NODE stays a 1px point, so ELK reserves no canvas around it and every edge
// keeps meeting at exactly one spot. The badge is drawn over that spot without
// taking up layout space (see TeamBadge).
//
// Handle naming matches BooNode's `'center'` source + `'center-target'`
// target so synthetic edges through team-roots can use the same handle
// IDs as every other dependency edge in the graph.

const HANDLE_STYLE: React.CSSProperties = {
  width: 1,
  height: 1,
  minWidth: 1,
  minHeight: 1,
  background: 'transparent',
  border: 'none',
  opacity: 0,
  pointerEvents: 'none',
}

export const TeamRootNode = memo(function TeamRootNode({
  id,
  data,
}: NodeProps<Node<TeamRootNodeData, 'team-root'>>) {
  // The hover cascade. Hovering the badge highlights this team's branch (React
  // Flow's node hover names this node), and hovering anything else dims the
  // badge with the rest of the canvas, the same as a Boo.
  const isHighlighted = useGraphStore(
    (s) => s.hoveredNodeId === null || (s.highlightedNodeIds?.has(id) ?? false),
  )

  return (
    <div style={{ width: 1, height: 1, position: 'relative' }}>
      {/* Source + target both anchored at the same 1px point. Edges
          from Boo Zero terminate here (target), and edges to team
          members originate here (source). */}
      <Handle
        type="target"
        position={Position.Top}
        id="center-target"
        style={HANDLE_STYLE}
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="center"
        style={HANDLE_STYLE}
        isConnectable={false}
      />
      <TeamBadge
        teamId={data.teamId}
        style={{
          // Centred on the 1px point the edges meet at.
          left: 0.5,
          top: 0.5,
          opacity: isHighlighted ? 1 : 0.22,
          transition: 'opacity 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
        }}
      />
    </div>
  )
})
