import { memo } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import {
  Cable,
  Database,
  KanbanSquare,
  MessagesSquare,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import { useGraphStore } from '../store'
import { useFloatingMotion } from '../useFloatingMotion'
import { usePeacockTransition } from '../usePeacockTransition'
import type { ResourceNodeData, ConnectorServiceKind } from '../types'

// ─── ResourceNode — the MCP-connector tile ────────────────────────────────────
//
// Part of the unified orbital tile family (see SkillNode's tile-system note):
// an OPAQUE violet-tinted disc + solid violet ring + a per-service glyph +
// a theme-foreground label. Violet is the CONNECTOR type accent — at a glance:
// violet = an attached MCP server, mint = a skill/tool, brand = the model,
// slate = built-ins, amber = leadership. Replaces the old faint amber card
// with the generic Plug icon and the shouty truncated uppercase label.

const VIOLET = 'var(--violet)'
const CIRCLE = 46 // matches the regular SkillNode tile

// Each clawboo MCP server gets a MEANINGFUL glyph (lucide, never emoji):
// memory → Database, tasks → Kanban, tools → Wrench, team chat → Messages.
// Unknown / third-party servers fall back to the Cable connector glyph.
const SERVICE_ICON: Record<ConnectorServiceKind, LucideIcon> = {
  memory: Database,
  tasks: KanbanSquare,
  tools: Wrench,
  teamchat: MessagesSquare,
  generic: Cable,
}

// ─── Handle style ─────────────────────────────────────────────────────────────

const handleStyle = {
  background: 'transparent',
  border: '1.5px solid rgb(var(--violet-rgb) / 0.45)',
  width: 7,
  height: 7,
}

// Invisible center handle style — used for edge path routing only
const centerHandleStyle: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  opacity: 0,
  pointerEvents: 'none',
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  border: 'none',
  background: 'transparent',
}

export const ResourceNode = memo(function ResourceNode({
  id: nodeId,
  data,
  dragging,
  positionAbsoluteX,
  positionAbsoluteY,
}: NodeProps<Node<ResourceNodeData, 'resource'>>) {
  const { name, fullName, serviceKind, isVisible, available, enabled, agentIds } = data
  const { orbitIndex, orbitCount } = data
  // Unavailable OR policy-disabled → greyed (matches SkillNode + the dashboard).
  const greyed = available === false || enabled === false
  const Icon = SERVICE_ICON[serviceKind ?? 'generic'] ?? Cable
  // Float with the SKILL motion profile: connector tiles are visual peers of
  // skill tiles in the same orbital fan, so a static tile next to gently
  // bobbing siblings would read as frozen/broken, not calm.
  const floatRef = useFloatingMotion(nodeId, 'skill', dragging)
  // See SkillNode: decorative hover/tap spring, dropped under reduced motion.
  const reduceMotion = useReducedMotion()

  // Hover cascade — dim when another node is hovered
  const isHighlighted = useGraphStore(
    (s) => s.hoveredNodeId === null || (s.highlightedNodeIds?.has(nodeId) ?? false),
  )

  // Peacock-feather expand / collapse — springs out FROM the parent Boo's
  // live center in arc order (see usePeacockTransition). Returns no-op
  // props when `isVisible` is undefined (MiniGraph context).
  const peacock = usePeacockTransition({
    nodeId,
    isVisible,
    parentAgentId: agentIds?.[0] ?? null,
    positionAbsoluteX,
    positionAbsoluteY,
    selfSize: CIRCLE,
    orbitIndex,
    orbitCount,
  })

  const tooltipBase = fullName && fullName !== name ? `${name} — ${fullName}` : name
  return (
    // Static root: the center Handle lives here, OUTSIDE the animated /
    // floating wrappers, so edges anchor to the stable geometric center.
    <div style={{ width: CIRCLE, height: CIRCLE, position: 'relative' }}>
      <motion.div
        initial={peacock.initial}
        animate={peacock.animate}
        transition={peacock.transition}
        style={{
          width: CIRCLE,
          height: CIRCLE,
          transformOrigin: 'center center',
          pointerEvents: peacock.pointerEvents,
        }}
      >
        <div ref={floatRef}>
          <div
            title={
              greyed
                ? `${tooltipBase} — ${enabled === false ? 'disabled' : 'unavailable'}`
                : `${tooltipBase} · attached MCP server`
            }
            style={{
              width: CIRCLE,
              height: CIRCLE,
              position: 'relative',
              overflow: 'visible',
              opacity: greyed ? (isHighlighted ? 0.5 : 0.16) : isHighlighted ? 1 : 0.22,
              filter: greyed ? 'grayscale(1)' : undefined,
              transition: 'opacity 0.3s cubic-bezier(0.32, 0.72, 0, 1), filter 0.3s ease',
            }}
          >
            {/* The tile disc — opaque violet-tinted surface (the connector
              accent). Hover lifts it with a small spring scale, matching
              the SkillNode micro-interaction. */}
            <motion.div
              whileHover={reduceMotion ? undefined : { scale: 1.08 }}
              whileTap={reduceMotion ? undefined : { scale: 0.94 }}
              transition={{ type: 'spring', stiffness: 420, damping: 24 }}
              style={{
                width: CIRCLE,
                height: CIRCLE,
                borderRadius: '50%',
                background: `color-mix(in srgb, ${VIOLET} 15%, var(--surface))`,
                border: `1.5px solid color-mix(in srgb, ${VIOLET} 65%, transparent)`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: `0 2px 8px color-mix(in srgb, ${VIOLET} 20%, transparent), inset 0 1px 0 rgb(var(--foreground-rgb) / 0.07)`,
              }}
            >
              <Icon size={20} strokeWidth={2} aria-hidden style={{ color: VIOLET }} />
            </motion.div>

            {/* Name below the disc — theme foreground (the accent lives on the tile). */}
            <div
              style={{
                position: 'absolute',
                top: CIRCLE + 6,
                left: '50%',
                transform: 'translateX(-50%)',
                fontSize: 11,
                fontWeight: 500,
                color: 'var(--foreground)',
                whiteSpace: 'nowrap',
                maxWidth: 104,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                textAlign: 'center',
                letterSpacing: '0.02em',
              }}
            >
              {name}
            </div>
          </div>
        </div>
      </motion.div>

      {/* Left handle — target for incoming edges from BooNodes. Lives on the
          STATIC root (see SkillNode's static-root-handles note): handle
          bounds are measured once at mount, so a handle inside the
          collapsed peacock transform would register far from the tile.
          Visibility rides a CSS fade tied to the peacock state. */}
      <Handle
        type="target"
        position={Position.Left}
        style={{
          ...handleStyle,
          opacity: isVisible === false ? 0 : 1,
          pointerEvents: isVisible === false ? 'none' : undefined,
          transition: 'opacity 0.2s ease',
        }}
      />

      {/* Center handle — invisible, edge routing only. */}
      <Handle id="center" type="target" position={Position.Left} style={centerHandleStyle} />
    </div>
  )
})
