import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'

// ─── TeamRootNode ─────────────────────────────────────────────────────────────
//
// Invisible routing-only node used in Atlas as the JUNCTION between Boo
// Zero and a team's cluster. Renders only the handle anchors React Flow
// needs to attach edges to — no Boo visual. ELK lays it out at level 1
// (between Boo Zero at level 0 and team members at level 2) so the edges
// naturally form the two-level trunk shape the user drew in the sketch:
//
//   Boo Zero
//      │
//   ───┴───      ← top trunk (BZ → team-roots)
//   │     │
//  TR-A  TR-B    ← invisible team-roots (this component)
//   │     │
//   ┌─┴─┐ ┌─┴─┐  ← per-team trunks (team-root → members)
//   m m m m m m  ← team members
//
// Width/height are kept at 1px so ELK doesn't reserve a visible block of
// canvas around the team-root — the layout still respects parent-child
// centering thanks to ELK's BRANDES_KOEPF placement, but the team-root
// itself is a single point in canvas space.
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

export const TeamRootNode = memo(function TeamRootNode(_props: NodeProps) {
  return (
    <div
      style={{
        width: 1,
        height: 1,
        position: 'relative',
        pointerEvents: 'none',
      }}
      aria-hidden
    >
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
    </div>
  )
})
